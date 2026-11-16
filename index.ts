/**
 * /migrate brings a session from another directory into the current one;
 * /move sends the current session to another directory. Both keep the session
 * id, history and subagent runs, and relink the sessions that point at it.
 */
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { activeRunsInProcess, liveOwner, registerLive, subagentState, unregisterLive } from "./guards.ts";
import { carryTail, recordMove, recoverTails } from "./journal.ts";
import { displayName, MigratePicker, migrationCandidates, relativeTime } from "./picker.ts";
import {
	affectedSessionFiles,
	applyMove,
	cwdDirName,
	planMove,
	readHeader,
	type AppliedMove,
	type MovePlan,
} from "./relocate.ts";
import { pickWithSearch } from "./session-search.ts";
import { completeDirectory, expandHome, isDirectory, parseWorktreeList, pathsFromConversation } from "./targets.ts";
import { trashFile } from "./trash.ts";

const MOVE_HERE = "Move here: same session, it leaves its old directory";
const COPY_HERE = "Copy here: new session, the original stays where it is";
const TYPE_PATH = "Type a path…";
const CANCEL = "Cancel";
const PICKER_TITLE = "Bring a session here";
/** A session written this recently may be open in a Pi that does not register itself here. */
const RECENT_WRITE_MS = 2 * 60 * 1000;

function stateDir(): string {
	return join(getAgentDir(), "session-relocate");
}

function liveDir(): string {
	return join(stateDir(), "live");
}

function journalFile(): string {
	return join(stateDir(), "journal.json");
}

function sessionsRoot(): string {
	return join(getAgentDir(), "sessions");
}

/** Forks can also sit in the archive of pi-session-archive; their links follow too. */
function linkRoots(): string[] {
	return [sessionsRoot(), join(getAgentDir(), "sessions-archive")];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Each session replacement loads a new extension instance in the same process;
// process-wide state lives on globalThis so it is set up and reported once.
const PROCESS_KEY = Symbol.for("pi-session-relocate.process");
interface PendingMove {
	plan: MovePlan;
	copiedBytes: number;
	completed: boolean;
	carriedTail: boolean;
}
interface ProcessState {
	exitHookInstalled: boolean;
	reportedConflicts: Set<string>;
	/**
	 * A move waiting for its switch. Pi tears the old runtime down before the
	 * new one starts, so the moved session's own extension instance completes
	 * the move on session_start, once the old runtime wrote its last entries.
	 * When the target directory does not load this extension, `withSession`
	 * completes it instead.
	 */
	pendingMove?: PendingMove;
}
function processState(): ProcessState {
	const runtime = globalThis as Record<symbol, ProcessState | undefined>;
	runtime[PROCESS_KEY] ??= { exitHookInstalled: false, reportedConflicts: new Set() };
	return runtime[PROCESS_KEY];
}

type Notify = ExtensionCommandContext["ui"]["notify"];

/**
 * Carry the late tail, trash the original, record the move and announce it.
 * `pi` is the moved session's own instance; without one, no event goes out.
 */
function completeMove(pi: ExtensionAPI | undefined, notify: Notify, pending: PendingMove): void {
	const { plan } = pending;
	pending.completed = true;
	if (plan.inPlace) {
		notify(`Session now belongs to ${plan.targetCwd}`, "info");
	} else {
		recordMove(journalFile(), { id: plan.header.id, from: plan.sourceFile, to: plan.destFile, movedAt: new Date().toISOString() });
		try {
			pending.carriedTail = carryTail(plan.sourceFile, plan.destFile, pending.copiedBytes);
			const where = trashFile(plan.sourceFile, join(stateDir(), "trash"));
			notify(`Session moved to ${plan.targetCwd}; its old file went to ${where}`, "info");
		} catch (error) {
			notify(`Session moved, but its old file stayed at ${plan.sourceFile}: ${errorText(error)}`, "warning");
		}
	}
	pi?.events.emit("session-relocate:v1:moved", {
		id: plan.header.id,
		from: plan.sourceFile,
		to: plan.destFile,
		fromCwd: plan.header.cwd,
		toCwd: plan.targetCwd,
	});
}

export default function sessionRelocate(pi: ExtensionAPI) {
	let sessionCwd = process.cwd();

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		const state = processState();
		if (!state.exitHookInstalled) {
			state.exitHookInstalled = true;
			process.once("exit", () => unregisterLive(liveDir()));
		}
		const file = ctx.sessionManager.getSessionFile();
		if (file) registerLive(liveDir(), file);
		else unregisterLive(liveDir());

		const pending = state.pendingMove;
		if (pending && !pending.completed && file === pending.plan.destFile) {
			completeMove(pi, (message, type) => ctx.ui.notify(message, type), pending);
		}

		for (const outcome of recoverTails(journalFile())) {
			if (outcome.kind === "merged") {
				const reopen = outcome.entry.to === file ? " Reopen this session with /resume to see them." : "";
				ctx.ui.notify(`Merged entries written to the old path of a moved session into ${outcome.entry.to}.${reopen}`, "info");
			} else if (!state.reportedConflicts.has(outcome.entry.from)) {
				state.reportedConflicts.add(outcome.entry.from);
				ctx.ui.notify(
					`A file reappeared at the old path of a moved session and could not be merged: ${outcome.entry.from} (moved copy: ${outcome.entry.to})`,
					"warning",
				);
			}
		}
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") unregisterLive(liveDir());
	});

	async function worktrees(cwd: string): Promise<string[] | undefined> {
		try {
			const result = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 5_000 });
			return result.code === 0 ? parseWorktreeList(result.stdout) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * A fresh plan for the move, or the reason it cannot happen now. Runs again
	 * after the confirmation, since the session or the destination can change
	 * while the dialog is open.
	 */
	async function prepareMove(
		sourceFile: string,
		targetCwd: string,
		isCurrent: boolean,
	): Promise<{ plan: MovePlan; error?: undefined } | { plan?: undefined; error: string }> {
		const owner = liveOwner(liveDir(), sourceFile);
		if (owner) return { error: `This session is open in another Pi process (pid ${owner}). Close it there first.` };
		const { activeRuns } = subagentState(sourceFile, getAgentDir());
		const active = activeRuns + (isCurrent ? await activeRunsInProcess(pi) : 0);
		if (active > 0) return { error: `${active} subagent run(s) are still active for this session. Wait for them or stop them first.` };
		let plan: MovePlan;
		try {
			plan = planMove(sourceFile, targetCwd, sessionsRoot(), linkRoots());
		} catch (error) {
			return { error: `Cannot move: ${errorText(error)}` };
		}
		for (const file of affectedSessionFiles(plan)) {
			const pid = liveOwner(liveDir(), file);
			if (pid) return { error: `A related session is open in another Pi process (pid ${pid}): ${file}. Close it there first.` };
		}
		return { plan };
	}

	function describePlan(plan: MovePlan, isCurrent: boolean): string {
		const lines = [`From: ${plan.header.cwd}`, `To: ${plan.targetCwd}`];
		if (plan.companions.length > 0) lines.push(`Moves along: ${plan.companions.length} subagent run folder(s) and artifact(s)`);
		if (plan.inboundLinks.length > 0) lines.push(`Relinks: ${plan.inboundLinks.length} fork(s) of this session`);
		const { staleReferences } = subagentState(plan.sourceFile, getAgentDir());
		if (staleReferences > 0) {
			lines.push(
				`Warning: ${staleReferences} pi-subagents run(s) or mission(s) keep the old path; resuming those runs from the moved session may not work.`,
			);
		}
		const idleMs = Date.now() - statSync(plan.sourceFile).mtimeMs;
		if (!isCurrent && idleMs < RECENT_WRITE_MS) {
			lines.push(
				`Warning: written ${Math.round(idleMs / 1000)}s ago. If a Pi without this extension has it open, close that Pi first.`,
			);
		}
		return lines.join("\n");
	}

	/**
	 * Move `sourceFile` to `targetCwd` and switch to it. The original only goes
	 * to the trash once the moved session started; a switch that never got
	 * there puts every file back where it was.
	 */
	async function moveAndSwitch(ctx: ExtensionCommandContext, sourceFile: string, targetCwd: string, isCurrent: boolean): Promise<void> {
		const first = await prepareMove(sourceFile, targetCwd, isCurrent);
		if (first.error !== undefined) {
			ctx.ui.notify(first.error, "error");
			return;
		}
		if (!(await ctx.ui.confirm("Move this session?", describePlan(first.plan, isCurrent)))) return;
		const { plan, error } = await prepareMove(sourceFile, targetCwd, isCurrent);
		if (error !== undefined) {
			ctx.ui.notify(error, "error");
			return;
		}

		let applied: AppliedMove;
		try {
			applied = applyMove(plan, isCurrent ? ctx.sessionManager.getLeafId() : undefined);
		} catch (error) {
			ctx.ui.notify(`Move failed, nothing changed: ${errorText(error)}`, "error");
			return;
		}

		const state = processState();
		const pending: PendingMove = { plan, copiedBytes: applied.copiedBytes, completed: false, carriedTail: false };
		state.pendingMove = pending;
		let switched = false;
		let cancelled = false;
		let failure: unknown;
		try {
			cancelled = (
				await ctx.switchSession(plan.destFile, {
					withSession: async (fresh) => {
						switched = true;
						if (!pending.completed) completeMove(undefined, (message, type) => fresh.ui.notify(message, type), pending);
						// Pi loaded the moved file before the old runtime wrote its last entries; reopen it to see them.
						if (pending.carriedTail) await fresh.switchSession(plan.destFile);
					},
				})
			).cancelled;
		} catch (error) {
			failure = error;
		} finally {
			if (state.pendingMove === pending) state.pendingMove = undefined;
		}
		if (switched || pending.completed) return;
		if (!cancelled && !oldRuntimeAlive(ctx)) {
			console.error(
				`pi-session-relocate: the switch failed after the old session closed; both copies are kept: ${plan.sourceFile} and ${plan.destFile}`,
			);
			return;
		}
		applied.rollback();
		ctx.ui.notify(cancelled ? "Move cancelled, nothing changed" : `Move failed, files put back: ${errorText(failure)}`, cancelled ? "info" : "error");
	}

	/** Whether the command's runtime still runs; after teardown its context throws, and the moved copy may be open. */
	function oldRuntimeAlive(ctx: ExtensionCommandContext): boolean {
		try {
			ctx.sessionManager.getSessionFile();
			return true;
		} catch {
			return false;
		}
	}

	async function copyAndSwitch(ctx: ExtensionCommandContext, sourceFile: string): Promise<void> {
		let file: string | undefined;
		try {
			file = SessionManager.forkFrom(sourceFile, ctx.cwd).getSessionFile();
		} catch (error) {
			ctx.ui.notify(`Copy failed: ${errorText(error)}`, "error");
			return;
		}
		if (!file) {
			ctx.ui.notify("Copy failed: Pi created no session file", "error");
			return;
		}
		await ctx.switchSession(file, {
			withSession: async (fresh) => fresh.ui.notify("Copied the session here; the original is unchanged", "info"),
		});
	}


	async function listSessions(ctx: ExtensionCommandContext): Promise<SessionInfo[]> {
		const dir = ctx.sessionManager.getSessionDir();
		const usesDefault = dir === join(sessionsRoot(), cwdDirName(ctx.cwd));
		return usesDefault ? SessionManager.listAll() : SessionManager.listAll(dir);
	}

	async function pickSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
		if (ctx.mode === "tui") {
			const searched = await pickWithSearch(pi, ctx, PICKER_TITLE);
			if (searched !== undefined) return searched ?? undefined;
		}
		const sessions = await listSessions(ctx);
		const repoDirs = await worktrees(ctx.cwd);
		if (ctx.mode === "tui") {
			const chosen = await ctx.ui.custom<SessionInfo | null>(
				(tui, theme, keybindings, done) =>
					new MigratePicker({
						sessions,
						cwd: ctx.cwd,
						repoDirs,
						theme,
						tui,
						keybindings,
						onSelect: (session) => done(session),
						onCancel: () => done(null),
					}),
			);
			return chosen?.path;
		}
		const candidates = migrationCandidates(sessions, ctx.cwd, undefined).slice(0, 30);
		const options = candidates.map((s) => `${displayName(s)}  ·  ${s.cwd}  ·  ${relativeTime(s.modified)}`);
		const choice = await ctx.ui.select(PICKER_TITLE, options);
		return choice === undefined ? undefined : candidates[options.indexOf(choice)]?.path;
	}

	pi.registerCommand("migrate", {
		description: "Bring a session from another directory here: move it or copy it",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const picked = await pickSession(ctx);
			if (!picked) return;
			if (!existsSync(picked)) {
				ctx.ui.notify("That session file is no longer on disk", "warning");
				return;
			}
			let cwd: string;
			try {
				cwd = readHeader(picked).header.cwd;
			} catch (error) {
				ctx.ui.notify(`Cannot read that session: ${errorText(error)}`, "error");
				return;
			}
			if (resolve(cwd) === resolve(ctx.cwd)) {
				await ctx.switchSession(picked);
				return;
			}
			const action = await ctx.ui.select(`Bring this session from ${cwd}`, [MOVE_HERE, COPY_HERE, CANCEL]);
			if (action === MOVE_HERE) await moveAndSwitch(ctx, picked, ctx.cwd, false);
			else if (action === COPY_HERE) await copyAndSwitch(ctx, picked);
		},
	});

	async function pickTarget(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const here = resolve(ctx.cwd);
		const fromGit = (await worktrees(ctx.cwd))?.map((dir) => resolve(dir)).filter((dir) => dir !== here && isDirectory(dir)) ?? [];
		const fromConversation = pathsFromConversation(ctx.sessionManager.getBranch(), ctx.cwd).filter((dir) => !fromGit.includes(dir));
		const labels = new Map<string, string>();
		for (const dir of fromGit) labels.set(`${dir}  (worktree)`, dir);
		for (const dir of fromConversation.slice(0, 15)) labels.set(`${dir}  (used in this session)`, dir);
		const choice = await ctx.ui.select("Move this session to", [...labels.keys(), TYPE_PATH, CANCEL]);
		if (choice === undefined || choice === CANCEL) return undefined;
		if (choice !== TYPE_PATH) return labels.get(choice);
		const typed = await ctx.ui.input("Target directory", "~/code/project");
		return typed?.trim() ? resolve(ctx.cwd, expandHome(typed.trim())) : undefined;
	}

	pi.registerCommand("move", {
		description: "Move this session to another directory, with its subagent runs",
		getArgumentCompletions: (prefix) =>
			completeDirectory(prefix, sessionCwd).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !existsSync(file)) {
				ctx.ui.notify("Nothing is saved in this session yet; start Pi in the target directory instead", "info");
				return;
			}
			const target = args.trim() ? resolve(ctx.cwd, expandHome(args.trim())) : await pickTarget(ctx);
			if (!target) return;
			if (!isDirectory(target)) {
				ctx.ui.notify(`Not a directory: ${target}`, "error");
				return;
			}
			await moveAndSwitch(ctx, file, target, true);
		},
	});
}
