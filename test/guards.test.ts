import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { liveOwner, registerLive, subagentState, unregisterLive } from "../guards.ts";

const SESSION = "/sessions/--work-app--/2026-10-01T10-00-00-000Z_01a0aaaa.jsonl";
const DEAD_PID = 2 ** 22 + 12345;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-session-relocate-guards-"));
	process.env.PI_SUBAGENTS_TEMP_ROOT = join(root, "subagents-temp");
});

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

test("a session open in another live process has an owner; the current process does not count", () => {
	const live = join(root, "live");
	registerLive(live, SESSION, process.ppid);
	registerLive(live, SESSION);
	assert.equal(liveOwner(live, SESSION), process.ppid);
	assert.equal(liveOwner(live, "/other.jsonl"), undefined);
	unregisterLive(live, process.ppid);
	assert.equal(liveOwner(live, SESSION), undefined);
});

test("records of dead processes are ignored and swept", () => {
	const live = join(root, "live");
	registerLive(live, SESSION, DEAD_PID);
	assert.equal(liveOwner(live, SESSION), undefined);
	assert.equal(existsSync(join(live, `${DEAD_PID}.json`)), false);
});

test("background runs block while their process lives; finished runs and missions only warn", () => {
	const runs = join(root, "subagents-temp", "async-subagent-runs");
	writeJson(join(runs, "r1", "status.json"), { sessionId: SESSION, state: "running", pid: process.pid });
	writeJson(join(runs, "r2", "status.json"), { sessionId: SESSION, state: "running", pid: DEAD_PID });
	writeJson(join(runs, "r3", "status.json"), { sessionId: SESSION, state: "complete", pid: process.pid });
	writeJson(join(runs, "r4", "status.json"), { sessionId: "/someone/else.jsonl", state: "running", pid: process.pid });
	const agentDir = join(root, "agent");
	writeJson(join(agentDir, "missions", "projects", "abc", "m1.json"), { ownerSessionId: SESSION });
	writeJson(join(agentDir, "missions", "projects", "abc", "m2.json"), { ownerSessionId: "/someone/else.jsonl" });

	assert.deepEqual(subagentState(SESSION, agentDir), { activeRuns: 1, staleReferences: 3 });
});

test("no pi-subagents state at all means nothing to report", () => {
	assert.deepEqual(subagentState(SESSION, join(root, "agent")), { activeRuns: 0, staleReferences: 0 });
});
