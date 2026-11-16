/** Where a session could go: worktrees of the current repo and directories the conversation used. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Paths listed by `git worktree list --porcelain`, main checkout first. */
export function parseWorktreeList(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

const SHELL_SEPARATOR = /&&|\|\||[;|\n]/;
/** `git worktree add` options that take a value. */
const WORKTREE_ADD_VALUE_OPTIONS = new Set(["-b", "-B", "--reason"]);

function unquote(token: string): string {
	return token.replace(/^["']|["']$/g, "");
}

/** Directories a shell command creates as a worktree or changes into. */
export function pathsInCommand(command: string): string[] {
	const found: string[] = [];
	for (const segment of command.split(SHELL_SEPARATOR)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		if (tokens[0] === "cd" && tokens[1]) {
			found.push(unquote(tokens[1]));
			continue;
		}
		const git = tokens.indexOf("git");
		const worktree = tokens.indexOf("worktree", git);
		if (git === -1 || worktree === -1 || tokens[worktree + 1] !== "add") continue;
		for (let i = worktree + 2; i < tokens.length; i++) {
			const token = tokens[i];
			if (WORKTREE_ADD_VALUE_OPTIONS.has(token)) i += 1;
			else if (!token.startsWith("-")) {
				found.push(unquote(token));
				break;
			}
		}
	}
	return found;
}

interface BranchEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

/**
 * Candidate directories from the tool calls of a conversation, most recent
 * first: `cwd` arguments and paths from bash `cd` and `git worktree add`.
 * Relative paths resolve against `baseCwd`; only existing directories other
 * than `baseCwd` survive.
 */
export function pathsFromConversation(entries: BranchEntry[], baseCwd: string): string[] {
	const raw: string[] = [];
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = Array.isArray(entry.message.content) ? entry.message.content : [];
		for (const block of [...content].reverse()) {
			if (block?.type !== "toolCall" || typeof block.arguments !== "object" || !block.arguments) continue;
			const args = block.arguments as Record<string, unknown>;
			if (typeof args.command === "string") raw.push(...pathsInCommand(args.command).reverse());
			if (typeof args.cwd === "string") raw.push(args.cwd);
		}
	}
	return uniqueDirectories(raw, baseCwd);
}

export function uniqueDirectories(paths: string[], baseCwd: string): string[] {
	const base = resolve(baseCwd);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const absolute = resolve(base, expandHome(path));
		if (absolute === base || seen.has(absolute) || !isDirectory(absolute)) continue;
		seen.add(absolute);
		result.push(absolute);
	}
	return result;
}

/** Directory completions for a typed path prefix, for `/move <path>`. */
export function completeDirectory(prefix: string, baseCwd: string): string[] {
	if (prefix === "~") prefix = "~/";
	const expanded = expandHome(prefix || ".");
	const absolute = isAbsolute(expanded) ? expanded : resolve(baseCwd, expanded);
	const endsWithSep = prefix === "" || prefix.endsWith("/") || prefix.endsWith(sep);
	const parent = endsWithSep ? absolute : dirname(absolute);
	const partial = endsWithSep ? "" : absolute.slice(parent.length + 1);
	if (!existsSync(parent)) return [];
	const typedParent = endsWithSep ? prefix : prefix.slice(0, prefix.length - partial.length);
	try {
		return readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(partial) && (partial.startsWith(".") || !entry.name.startsWith(".")))
			.map((entry) => `${typedParent}${entry.name}/`)
			.sort()
			.slice(0, 50);
	} catch {
		return [];
	}
}
