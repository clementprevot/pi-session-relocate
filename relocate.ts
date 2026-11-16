/**
 * Filesystem core: relocate a session file to the per-cwd directory of another
 * working directory, keeping its id and history, and carry along everything
 * that lives beside it or points at it. Pure Node, no Pi runtime, so tests can
 * drive it against a temporary sessions tree.
 */
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface SessionHeader {
	type: "session";
	id: string;
	cwd: string;
	parentSession?: string;
	[key: string]: unknown;
}

const HEADER_SCAN_MAX = 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;

/** Same encoding Pi uses for per-cwd session directories. */
export function cwdDirName(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const HEADER_CHUNK = 4096;

export function readHeader(file: string): { header: SessionHeader; bodyOffset: number } {
	const fd = openSync(file, "r");
	try {
		const chunks: Buffer[] = [];
		let length = 0;
		let newline = -1;
		while (newline === -1 && length < HEADER_SCAN_MAX) {
			const chunk = Buffer.alloc(HEADER_CHUNK);
			const read = readSync(fd, chunk, 0, HEADER_CHUNK, length);
			if (read === 0) break;
			const at = chunk.subarray(0, read).indexOf(0x0a);
			if (at !== -1) newline = length + at;
			chunks.push(chunk.subarray(0, read));
			length += read;
		}
		if (newline === -1) throw new Error(`No session header line in ${file}`);
		const header = JSON.parse(Buffer.concat(chunks).subarray(0, newline).toString("utf8"));
		if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
			throw new Error(`Not a Pi session file: ${file}`);
		}
		return { header, bodyOffset: newline + 1 };
	} finally {
		closeSync(fd);
	}
}

function tryReadHeader(file: string): SessionHeader | undefined {
	try {
		return readHeader(file).header;
	} catch {
		return undefined;
	}
}

/**
 * Write `header` then the body of `source` (from `bodyOffset`) to `dest`,
 * through a temp file so a crash never leaves a truncated session. A new
 * `dest` is published with a hard link, which fails instead of overwriting a
 * file that appeared meanwhile; only an in-place rewrite replaces `dest`.
 * Returns the size of `source` that was copied, to detect later appends.
 */
export function writeWithHeader(source: string, dest: string, header: SessionHeader, bodyOffset: number): number {
	const tmp = `${dest}.relocate-${randomUUID()}.tmp`;
	const readFd = openSync(source, "r");
	let writeFd: number | undefined;
	try {
		writeFd = openSync(tmp, "w");
		writeFileSync(writeFd, `${JSON.stringify(header)}\n`);
		const chunk = Buffer.alloc(CHUNK_SIZE);
		let position = bodyOffset;
		for (;;) {
			const read = readSync(readFd, chunk, 0, CHUNK_SIZE, position);
			if (read === 0) break;
			writeFileSync(writeFd, chunk.subarray(0, read));
			position += read;
		}
		closeSync(writeFd);
		writeFd = undefined;
		if (dest === source) {
			renameSync(tmp, dest);
		} else {
			linkSync(tmp, dest);
			unlinkSync(tmp);
		}
		return position;
	} catch (error) {
		if (writeFd !== undefined) closeSync(writeFd);
		if (existsSync(tmp)) unlinkSync(tmp);
		throw error;
	} finally {
		closeSync(readFd);
	}
}

function rewriteHeader(file: string, patch: (header: SessionHeader) => SessionHeader): void {
	const { header, bodyOffset } = readHeader(file);
	writeWithHeader(file, file, patch(header), bodyOffset);
}

function setParent(file: string, parentSession: string | undefined): void {
	rewriteHeader(file, (header) => {
		const next = { ...header, parentSession };
		if (parentSession === undefined) delete next.parentSession;
		return next;
	});
}


function parentSessionId(metaFile: string): string | undefined {
	try {
		return JSON.parse(readFileSync(metaFile, "utf8")).parentSessionId;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ARTIFACT_SUFFIX = /^_(?:input\.md|output\.md|meta\.json|transcript\.jsonl)$/;

/**
 * Paths, relative to a per-cwd sessions dir, that belong to a session beside its
 * file: its `<file>/` dir (subagent runs, forks), its subagent-artifacts runs, and its agent-browser screenshots.
 * `id` comes from the header: session ids may contain underscores, so the file name cannot tell it reliably.
 */
export function findCompanions(dir: string, file: string, id: string): string[] {
	const found = [basename(file, ".jsonl"), join(".pi-agent-browser-artifacts", id)].filter((rel) =>
		existsSync(join(dir, rel)),
	);
	const artifactsDir = join(dir, "subagent-artifacts");
	if (!existsSync(artifactsDir)) return found;
	const names = readdirSync(artifactsDir);
	for (const meta of names.filter((name) => name.endsWith("_meta.json"))) {
		if (parentSessionId(join(artifactsDir, meta)) !== id) continue;
		const run = meta.slice(0, -"_meta.json".length);
		for (const name of names) {
			if (name.startsWith(run) && SUBAGENT_ARTIFACT_SUFFIX.test(name.slice(run.length))) {
				found.push(join("subagent-artifacts", name));
			}
		}
	}
	return found;
}

function listJsonl(dir: string, recursive: boolean): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		else if (recursive && entry.isDirectory()) files.push(...listJsonl(path, true));
	}
	return files;
}

/** Sessions anywhere under the given roots whose `parentSession` matches (forks and clones of a moved session). */
export function findInboundLinks(roots: string[], matches: (parentSession: string) => boolean): string[] {
	const found: string[] = [];
	for (const root of roots) {
		for (const candidate of listJsonl(root, true)) {
			const parent = tryReadHeader(candidate)?.parentSession;
			if (parent && matches(parent)) found.push(candidate);
		}
	}
	return found;
}

/** Session files other than the source that a plan moves or rewrites, to check that none is open elsewhere. */
export function affectedSessionFiles(plan: MovePlan): string[] {
	const sourceDir = dirname(plan.sourceFile);
	const moved = plan.companions.flatMap((rel) => listJsonl(join(sourceDir, rel), true));
	return [...moved, ...plan.inboundLinks];
}

/**
 * Where a path that pointed at the source session or inside one of its
 * companions lives after the move; undefined for unrelated paths.
 */
export function movedPath(plan: Pick<MovePlan, "sourceFile" | "destFile" | "companions">, path: string): string | undefined {
	if (path === plan.sourceFile) return plan.destFile;
	const sourceDir = dirname(plan.sourceFile);
	const destDir = dirname(plan.destFile);
	for (const rel of plan.companions) {
		const from = join(sourceDir, rel);
		if (path === from || path.startsWith(`${from}${sep}`)) return join(destDir, rel) + path.slice(from.length);
	}
	return undefined;
}

export interface MovePlan {
	sourceFile: string;
	destFile: string;
	targetCwd: string;
	header: SessionHeader;
	bodyOffset: number;
	/** Same path: a custom session dir that is not split per cwd, only the header changes. */
	inPlace: boolean;
	/** Relative to the source dir; they land at the same relative path in the destination dir. */
	companions: string[];
	inboundLinks: string[];
}

/**
 * Work out where a session goes. Sessions in Pi's default per-cwd layout move
 * to the target cwd's directory; sessions in any other directory keep their
 * path and only get the new cwd. Throws before anything is written when the
 * destination is taken.
 */
export function planMove(sourceFile: string, targetCwd: string, sessionsRoot: string, linkRoots: string[]): MovePlan {
	const { header, bodyOffset } = readHeader(sourceFile);
	const cwd = resolve(targetCwd);
	if (resolve(header.cwd) === cwd) throw new Error(`The session already belongs to ${cwd}`);
	const sourceDir = dirname(sourceFile);
	const inDefaultLayout = sourceDir === join(sessionsRoot, cwdDirName(header.cwd));
	const destDir = inDefaultLayout ? join(sessionsRoot, cwdDirName(cwd)) : sourceDir;
	const destFile = join(destDir, basename(sourceFile));
	const inPlace = destFile === sourceFile;
	if (!inPlace && existsSync(destFile)) throw new Error(`A session file already exists at ${destFile}`);
	const companions = inPlace ? [] : findCompanions(sourceDir, sourceFile, header.id);
	for (const rel of companions) {
		if (existsSync(join(destDir, rel))) throw new Error(`Destination already has ${join(destDir, rel)}`);
	}
	const plan = { sourceFile, destFile, targetCwd: cwd, header, bodyOffset, inPlace, companions, inboundLinks: [] as string[] };
	if (!inPlace) {
		plan.inboundLinks = findInboundLinks(linkRoots, (parent) => movedPath(plan, parent) !== undefined).filter(
			(file) => movedPath(plan, file) === undefined,
		);
	}
	return plan;
}

export interface AppliedMove {
	plan: MovePlan;
	/** Bytes of the source already copied; anything Pi appends past this is a tail to carry over. */
	copiedBytes: number;
	rollback(): void;
}

/**
 * Apply a plan without touching the source file: copy it with the new cwd,
 * move its companions, and relink every session that points at it. Any failure
 * undoes the steps already done, so the session is either fully moved or left
 * as it was. `leafId`, when given, is the entry the session should reopen on.
 */
export function applyMove(plan: MovePlan, leafId?: string | null): AppliedMove {
	const undo: Array<() => void> = [];
	const rollback = () => {
		for (const step of undo.reverse()) {
			try {
				step();
			} catch {
				// keep unwinding: a step that cannot be undone must not strand the others
			}
		}
		undo.length = 0;
	};
	try {
		const header = { ...plan.header, cwd: plan.targetCwd };
		mkdirSync(dirname(plan.destFile), { recursive: true });
		const copiedBytes = writeWithHeader(plan.sourceFile, plan.destFile, header, plan.bodyOffset);
		if (plan.inPlace) {
			undo.push(() => rewriteHeader(plan.destFile, (current) => ({ ...current, cwd: plan.header.cwd })));
		} else {
			undo.push(() => unlinkSync(plan.destFile));
		}
		// In place, the file is the live one: an entry appended there could not be taken back safely.
		if (leafId && !plan.inPlace) appendMoveMarker(plan, leafId);

		const sourceDir = dirname(plan.sourceFile);
		const destDir = dirname(plan.destFile);
		const movedDirs: string[] = [];
		for (const rel of plan.companions) {
			const from = join(sourceDir, rel);
			const to = join(destDir, rel);
			if (existsSync(to)) throw new Error(`Destination already has ${to}`);
			mkdirSync(dirname(to), { recursive: true });
			renameSync(from, to);
			undo.push(() => renameSync(to, from));
			if (statSync(to).isDirectory()) movedDirs.push(to);
		}

		const linked = [...movedDirs.flatMap((dir) => listJsonl(dir, true)), ...plan.inboundLinks];
		for (const file of linked) {
			const parent = tryReadHeader(file)?.parentSession;
			const next = parent ? movedPath(plan, parent) : undefined;
			if (!next) continue;
			setParent(file, next);
			undo.push(() => setParent(file, parent));
		}
		return { plan, copiedBytes, rollback };
	} catch (error) {
		rollback();
		throw error;
	}
}

/**
 * Pins the reopen point: Pi resumes a session at its last entry, which is not
 * the active one when the user navigated `/tree` before moving.
 */
function appendMoveMarker(plan: MovePlan, leafId: string): void {
	const marker = {
		type: "custom",
		customType: "session-relocate",
		id: randomUUID().slice(0, 8),
		parentId: leafId,
		timestamp: new Date().toISOString(),
		data: { from: plan.header.cwd, to: plan.targetCwd },
	};
	const content = readFileSync(plan.destFile, "utf8");
	appendFileSync(plan.destFile, `${content.endsWith("\n") ? "" : "\n"}${JSON.stringify(marker)}\n`);
}
