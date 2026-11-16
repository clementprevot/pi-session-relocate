import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { migrationCandidates } from "../picker.ts";
import { completeDirectory, parseWorktreeList, pathsFromConversation, pathsInCommand } from "../targets.ts";

test("worktree paths come from the porcelain listing, main checkout first", () => {
	const output = "worktree /work/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /work/app-feature\nHEAD def\ndetached\n";
	assert.deepEqual(parseWorktreeList(output), ["/work/app", "/work/app-feature"]);
});

test("worktree add and cd paths are found in shell commands", () => {
	assert.deepEqual(pathsInCommand("git worktree add ../app-feature feature"), ["../app-feature"]);
	assert.deepEqual(pathsInCommand("git worktree add -b feature ~/wt/app-feature origin/main"), ["~/wt/app-feature"]);
	assert.deepEqual(pathsInCommand("git fetch && git worktree add --detach '/work/app-review' && cd /work/app-review"), [
		"/work/app-review",
		"/work/app-review",
	]);
	assert.deepEqual(pathsInCommand("git worktree list"), []);
	assert.deepEqual(pathsInCommand("echo cd nowhere"), []);
});

test("conversation paths are the existing directories the tools used, newest first", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-session-relocate-targets-"));
	mkdirSync(join(base, "older"));
	mkdirSync(join(base, "newer"));
	mkdirSync(join(base, "sub"));
	const call = (args: Record<string, unknown>) => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "tool", arguments: args }] },
	});
	const entries = [
		call({ command: "cd older && ls" }),
		{ type: "message", message: { role: "user", content: "cd sub" } },
		call({ command: `git worktree add ${join(base, "gone")} x` }),
		call({ cwd: "sub" }),
		call({ command: "cd newer" }),
		call({ command: "cd ." }),
	];
	assert.deepEqual(pathsFromConversation(entries, base), [join(base, "newer"), join(base, "sub"), join(base, "older")]);
});

test("directory completion follows the typed prefix and hides dot folders unless asked", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-session-relocate-complete-"));
	mkdirSync(join(base, "app"));
	mkdirSync(join(base, "app-feature"));
	mkdirSync(join(base, ".hidden"));
	assert.deepEqual(completeDirectory("ap", base), ["app-feature/", "app/"].sort());
	assert.deepEqual(completeDirectory("", base), ["app-feature/", "app/"].sort());
	assert.deepEqual(completeDirectory(".h", base), [".hidden/"]);
	assert.deepEqual(completeDirectory(`${base}/app-`, "/"), [`${base}/app-feature/`]);
	assert.deepEqual(completeDirectory("missing/x", base), []);
});

test("migration candidates exclude the current directory and can be scoped to the repository", () => {
	const session = (path: string, cwd: string, modified: string) =>
		({ path, cwd, modified: new Date(modified), firstMessage: path, name: undefined }) as unknown as SessionInfo;
	const sessions = [
		session("here", "/work/app-feature", "2026-11-03"),
		session("main", "/work/app", "2026-11-01"),
		session("other", "/elsewhere", "2026-11-02"),
	];
	assert.deepEqual(migrationCandidates(sessions, "/work/app-feature", undefined).map((s) => s.path), ["other", "main"]);
	assert.deepEqual(
		migrationCandidates(sessions, "/work/app-feature", ["/work/app", "/work/app-feature"]).map((s) => s.path),
		["main"],
	);
});
