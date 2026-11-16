/**
 * Checks that run before a move. Pi has no lock on session files and appends
 * to them by path, so a session open in another process, or with subagents
 * still writing beside it, must not move.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface LiveRecord {
	pid: number;
	sessionFile: string;
}

/** One file per Pi process that loads this extension, naming the session it has open. */
export function registerLive(dir: string, sessionFile: string, pid = process.pid): void {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${pid}.json`);
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify({ pid, sessionFile } satisfies LiveRecord));
	renameSync(tmp, file);
}

export function unregisterLive(dir: string, pid = process.pid): void {
	try {
		unlinkSync(join(dir, `${pid}.json`));
	} catch {
		// already gone
	}
}

/** Pid of another live process that has `sessionFile` open; records of dead processes are swept. */
export function liveOwner(dir: string, sessionFile: string, selfPid = process.pid): number | undefined {
	if (!existsSync(dir)) return undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		let record: LiveRecord;
		try {
			record = JSON.parse(readFileSync(join(dir, name), "utf8"));
		} catch {
			continue;
		}
		if (!isProcessAlive(record.pid)) {
			unregisterLive(dir, record.pid);
			continue;
		}
		if (record.pid !== selfPid && record.sessionFile === sessionFile) return record.pid;
	}
	return undefined;
}

const RUNNING_STATES = new Set(["running", "pending", "queued"]);

export interface SubagentState {
	/** Background runs of this session whose process is still alive. */
	activeRuns: number;
	/** Finished runs and missions that name the session by path and will keep the old one. */
	staleReferences: number;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function subagentTempRoots(): string[] {
	const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (configured) return [configured];
	return readdirSync(tmpdir())
		.filter((name) => name.startsWith("pi-subagents-"))
		.map((name) => join(tmpdir(), name));
}

/**
 * pi-subagents state that names a session by its file path: background run
 * statuses and missions. Best effort, it reads pi-subagents' on-disk layout
 * and finds nothing when that extension is absent or changes its format.
 */
export function subagentState(sessionFile: string, agentDir: string): SubagentState {
	let activeRuns = 0;
	let staleReferences = 0;
	for (const root of subagentTempRoots()) {
		const runsDir = join(root, "async-subagent-runs");
		if (!existsSync(runsDir)) continue;
		for (const run of readdirSync(runsDir)) {
			const status = readJson(join(runsDir, run, "status.json"));
			if (status?.sessionId !== sessionFile) continue;
			const running = RUNNING_STATES.has(String(status.state)) && typeof status.pid === "number" && isProcessAlive(status.pid);
			if (running) activeRuns += 1;
			else staleReferences += 1;
		}
	}
	const projectsDir = join(agentDir, "missions", "projects");
	if (existsSync(projectsDir)) {
		for (const project of readdirSync(projectsDir)) {
			const dir = join(projectsDir, project);
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (name.endsWith(".json") && readJson(join(dir, name))?.ownerSessionId === sessionFile) staleReferences += 1;
			}
		}
	}
	return { activeRuns, staleReferences };
}

const RPC_TIMEOUT_MS = 500;

/** Active pi-subagents runs of this process, through its in-process RPC; no reply counts as none. */
export function activeRunsInProcess(pi: ExtensionAPI): Promise<number> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		const finish = (count: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(count);
		};
		const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (data: unknown) => {
			const fleet = (data as { success?: boolean; data?: { fleet?: { totalActive?: number; entries?: unknown[] } } })
				?.data?.fleet;
			finish(fleet?.totalActive ?? fleet?.entries?.length ?? 0);
		});
		const timer = setTimeout(() => finish(0), RPC_TIMEOUT_MS);
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status" });
	});
}
