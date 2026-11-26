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
import {
	agentMoveTarget,
	completeDirectory,
	expandHome,
	isDirectory,
	parseWorktreeList,
	pathsFromConversation,
} from "./targets.ts";
import { trashFile } from "./trash.ts";
import { Type } from "typebox";

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
/** Not exported by Pi: the context `withSession` receives after a switch. */
type ReplacedSessionContext = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>
>[0];

/** A move the agent asked for with session_move, run by /move once the turn settles. */
interface AgentMove {
	dir: string;
	then?: string;
}

const MESSAGE_TYPE = "session-relocate";

function movedMessage(dir: string, then: string | undefined) {
	const content = then
		? `This session now belongs to ${dir}. Continue with: ${then}`
		: `This session now belongs to ${dir}.`;
	return { customType: MESSAGE_TYPE, content, display: true };
}

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
	/** The agent's session_move request: queued during its turn, dispatched as /move once the turn settles. */
	let queuedMove: AgentMove | undefined;
	let dispatchedMove: AgentMove | undefined;

	/** Tells the model, in this session, why the move it asked for did not happen. */
	function tellAgent(content: string): void {
		pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

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
	 * there puts every file back where it was. An agent request skips the
	 * confirmation, since session_move only accepts worktrees of the same repo,
	 * and hands its follow-up to the moved session.
	 */
	async function moveAndSwitch(
		ctx: ExtensionCommandContext,
		sourceFile: string,
		targetCwd: string,
		isCurrent: boolean,
		request?: AgentMove,
	): Promise<void> {
		const refuse = (message: string, type: "info" | "error") => {
			ctx.ui.notify(message, type);
			if (request) tellAgent(`session_move did not happen: ${message}`);
		};
		const first = await prepareMove(sourceFile, targetCwd, isCurrent);
		if (first.error !== undefined) {
			refuse(first.error, "error");
			return;
		}
		if (!request && !(await ctx.ui.confirm("Move this session?", describePlan(first.plan, isCurrent)))) return;
		const { plan, error } = await prepareMove(sourceFile, targetCwd, isCurrent);
		if (error !== undefined) {
			refuse(error, "error");
			return;
		}

		let applied: AppliedMove;
		try {
			applied = applyMove(plan, isCurrent ? ctx.sessionManager.getLeafId() : undefined);
		} catch (error) {
			refuse(`Move failed, nothing changed: ${errorText(error)}`, "error");
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
						const followUp = request ? movedMessage(plan.targetCwd, request.then) : undefined;
						const continueIn = async (session: ReplacedSessionContext) => {
							if (followUp) await session.sendMessage(followUp, { triggerTurn: request?.then !== undefined });
						};
						// Pi loaded the moved file before the old runtime wrote its last entries; reopen it to see them.
						if (pending.carriedTail) await fresh.switchSession(plan.destFile, { withSession: continueIn });
						else await continueIn(fresh);
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
		refuse(cancelled ? "Move cancelled, nothing changed" : `Move failed, files put back: ${errorText(failure)}`, cancelled ? "info" : "error");
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
			const request = dispatchedMove?.dir === target ? dispatchedMove : undefined;
			dispatchedMove = undefined;
			await moveAndSwitch(ctx, file, target, true, request);
		},
	});

	pi.registerTool({
		name: "session_move",
		label: "Move session",
		description:
			"Move this session to another worktree of the same repository, for example the main checkout before deleting the current worktree. " +
			"The move runs when this turn ends: the session reopens in the target directory with its history, and `then` is delivered there as the next instruction. " +
			"Only worktrees of the current repository are accepted; for any other directory, ask the user to run /move.",
		parameters: Type.Object({
			target: Type.String({ description: "Directory to move to: another worktree of this repository, such as the main checkout" }),
			then: Type.Optional(Type.String({ description: "What to do once the session runs in the target directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !existsSync(file)) return fail("Nothing is saved in this session yet, so it cannot move.");
			const checked = agentMoveTarget(params.target, ctx.cwd, await worktrees(ctx.cwd));
			if (checked.error !== undefined) return fail(checked.error);
			queuedMove = { dir: checked.dir, then: params.then };
			return {
				content: [{ type: "text", text: `Move to ${checked.dir} queued. It runs when this turn ends; stop here.` }],
				details: { target: checked.dir },
				terminate: true,
			};
		},
	});

	pi.on("agent_settled", () => {
		if (!queuedMove) return;
		dispatchedMove = queuedMove;
		queuedMove = undefined;
		pi.sendUserMessage(`/move ${dispatchedMove.dir}`, { expandPromptTemplates: true });
	});
}
