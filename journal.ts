/**
 * Late writes: entries Pi appends to a session's old path after it moved, and
 * the journal of recent moves that lets a later session start find them.
 */
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function appendLines(dest: string, text: string): void {
	const separator = readFileSync(dest, "utf8").endsWith("\n") ? "" : "\n";
	appendFileSync(dest, `${separator}${text}${text.endsWith("\n") ? "" : "\n"}`);
}

/** Entries Pi appended to the source after the copy, carried over to the destination. */
export function carryTail(source: string, dest: string, copiedBytes: number): boolean {
	if (!existsSync(source)) return false;
	const size = statSync(source).size;
	if (size <= copiedBytes) return false;
	const fd = openSync(source, "r");
	try {
		const tail = Buffer.alloc(size - copiedBytes);
		readSync(fd, tail, 0, tail.length, copiedBytes);
		appendLines(dest, tail.toString("utf8"));
		return true;
	} finally {
		closeSync(fd);
	}
}

interface TreeEntry {
	id: string;
	parentId: string;
	line: string;
}

/** Every line must be a tree entry with a parent; anything else (a header, a torn write) rejects the whole file. */
function parseTail(text: string): TreeEntry[] | undefined {
	const entries: TreeEntry[] = [];
	for (const line of text.split("\n").filter((l) => l.trim())) {
		let entry: { id?: unknown; parentId?: unknown; type?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (typeof entry?.id !== "string" || typeof entry.parentId !== "string" || entry.type === "session") return undefined;
		entries.push({ id: entry.id, parentId: entry.parentId, line });
	}
	return entries.length > 0 ? entries : undefined;
}

function entryIds(file: string): Set<string> {
	const ids = new Set<string>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const id = JSON.parse(line)?.id;
			if (typeof id === "string") ids.add(id);
		} catch {
			// a torn line in the moved copy holds no id to match
		}
	}
	return ids;
}

function chainsOnto(tail: TreeEntry[], movedIds: Set<string>): boolean {
	const tailIds = new Set(tail.map((entry) => entry.id));
	return (
		tail.some((entry) => movedIds.has(entry.parentId)) &&
		tail.every((entry) => movedIds.has(entry.parentId) || tailIds.has(entry.parentId))
	);
}

/**
 * A headerless file at an old path is the tail Pi kept writing after the move:
 * append it to the moved copy when every entry chains onto it. The fragment is
 * claimed by a rename first, so a write that lands meanwhile starts a new
 * fragment instead of being lost, and entries already in the moved copy are
 * skipped, so a merge interrupted halfway can safely run again.
 */
export function appendIfContinuation(fragment: string, moved: string): boolean {
	const preview = parseTail(readFileSync(fragment, "utf8"));
	if (!preview || !chainsOnto(preview, entryIds(moved))) return false;
	const claimed = `${fragment}.relocate-claim-${randomUUID()}`;
	renameSync(fragment, claimed);
	const tail = parseTail(readFileSync(claimed, "utf8"));
	const movedIds = entryIds(moved);
	if (!tail || !chainsOnto(tail, movedIds)) {
		if (!existsSync(fragment)) renameSync(claimed, fragment);
		return false;
	}
	const fresh = tail.filter((entry) => !movedIds.has(entry.id));
	if (fresh.length > 0) appendLines(moved, fresh.map((entry) => entry.line).join("\n"));
	unlinkSync(claimed);
	return true;
}

export interface JournalEntry {
	id: string;
	from: string;
	to: string;
	movedAt: string;
}

const JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function readJournal(file: string): JournalEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeJournal(file: string, entries: JournalEntry[]): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(entries, null, "\t"));
	renameSync(tmp, file);
}

/**
 * Older moves of the same session follow it to its new path, so a late write
 * at any former path still finds the session. The path it lives at now is no
 * longer a former path: entries starting there are dropped.
 */
export function recordMove(file: string, entry: JournalEntry, now = Date.now()): void {
	const kept = readJournal(file)
		.filter((e) => now - Date.parse(e.movedAt) < JOURNAL_RETENTION_MS)
		.map((e) => (e.to === entry.from ? { ...e, to: entry.to } : e))
		.filter((e) => e.from !== e.to && e.from !== entry.to && e.from !== entry.from);
	writeJournal(file, [...kept, entry]);
}

export type TailOutcome = { kind: "merged"; entry: JournalEntry } | { kind: "conflict"; entry: JournalEntry };

/**
 * Look for files that reappeared at the old path of a recorded move, which
 * happens when another Pi process kept the session open. Headerless tails that
 * chain onto the moved copy are merged; anything else is reported untouched.
 */
export function recoverTails(journalFile: string): TailOutcome[] {
	const outcomes: TailOutcome[] = [];
	for (const entry of readJournal(journalFile)) {
		if (!existsSync(entry.from) || !existsSync(entry.to)) continue;
		try {
			outcomes.push({ kind: appendIfContinuation(entry.from, entry.to) ? "merged" : "conflict", entry });
		} catch {
			// another Pi starting at the same time claimed this fragment first
		}
	}
	return outcomes;
}
