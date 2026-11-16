import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { carryTail, readJournal, recordMove, recoverTails } from "../journal.ts";
import { affectedSessionFiles, applyMove, cwdDirName, findCompanions, planMove, readHeader } from "../relocate.ts";

const ID = "01a0aaaa-0000-7000-8000-000000000001";
const OTHER_ID = "01a0bbbb-0000-7000-8000-000000000002";
const FILE = `2026-10-01T10-00-00-000Z_${ID}.jsonl`;
const FROM = "/work/app";
const TO = "/work/app-feature";

let root: string;
let sessions: string;
let source: string;

const header = (id: string, cwd: string, parentSession?: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T10:00:00.000Z", cwd, ...(parentSession ? { parentSession } : {}) });
const entry = (id: string, parentId: string | null) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-01T10:00:01.000Z", message: { role: "user", content: id, timestamp: 1 } });

function writeLines(path: string, lines: string[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`);
}

function headerOf(path: string) {
	return readHeader(path).header;
}

function body(path: string): string {
	return readFileSync(path, "utf8").split("\n").slice(1).join("\n");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-session-relocate-"));
	sessions = join(root, "sessions");
	source = join(sessions, cwdDirName(FROM), FILE);
	writeLines(source, [header(ID, FROM), entry("a1", null), entry("a2", "a1")]);
});

function seedCompanions(): { child: string; grandchild: string } {
	const dir = join(sessions, cwdDirName(FROM));
	const child = join(dir, FILE.replace(".jsonl", ""), "run1", "run-0", "session.jsonl");
	writeLines(child, [header("child", "/tmp/elsewhere", source)]);
	const grandchild = join(dir, FILE.replace(".jsonl", ""), "run1", "run-0", "session", "run2", "run-0", "session.jsonl");
	writeLines(grandchild, [header("grandchild", "/tmp/elsewhere", child)]);
	writeLines(join(dir, ".pi-agent-browser-artifacts", ID, "shot.png"), ["png"]);
	writeLines(join(dir, "subagent-artifacts", "run1_reviewer_meta.json"), [JSON.stringify({ parentSessionId: ID })]);
	writeLines(join(dir, "subagent-artifacts", "run1_reviewer_output.md"), ["out"]);
	writeLines(join(dir, "subagent-artifacts", "run9_reviewer_meta.json"), [JSON.stringify({ parentSessionId: OTHER_ID })]);
	return { child, grandchild };
}

test("a move copies the session with the new cwd and leaves the source untouched", () => {
	const before = readFileSync(source, "utf8");
	const plan = planMove(source, TO, sessions, [sessions]);
	const applied = applyMove(plan);

	assert.equal(plan.destFile, join(sessions, cwdDirName(TO), FILE));
	assert.equal(headerOf(plan.destFile).cwd, TO);
	assert.equal(headerOf(plan.destFile).id, ID);
	assert.equal(body(plan.destFile), body(source));
	assert.equal(readFileSync(source, "utf8"), before);
	assert.equal(applied.copiedBytes, before.length);
});

test("subagent runs, screenshots and artifacts move along, and child links follow", () => {
	const { child, grandchild } = seedCompanions();
	const plan = planMove(source, TO, sessions, [sessions]);
	applyMove(plan);

	const destDir = join(sessions, cwdDirName(TO));
	const movedChild = join(destDir, FILE.replace(".jsonl", ""), "run1", "run-0", "session.jsonl");
	const movedGrandchild = join(destDir, FILE.replace(".jsonl", ""), "run1", "run-0", "session", "run2", "run-0", "session.jsonl");
	assert.equal(existsSync(child), false);
	assert.equal(headerOf(movedChild).parentSession, plan.destFile);
	assert.equal(headerOf(movedChild).cwd, "/tmp/elsewhere");
	assert.equal(headerOf(movedGrandchild).parentSession, movedChild);
	assert.equal(existsSync(grandchild), false);
	assert.ok(existsSync(join(destDir, ".pi-agent-browser-artifacts", ID, "shot.png")));
	assert.ok(existsSync(join(destDir, "subagent-artifacts", "run1_reviewer_output.md")));
	assert.ok(existsSync(join(sessions, cwdDirName(FROM), "subagent-artifacts", "run9_reviewer_meta.json")));
});

test("forks living in other directories are relinked to the new path", () => {
	const fork = join(sessions, cwdDirName("/work/other"), `2026-10-02T10-00-00-000Z_${OTHER_ID}.jsonl`);
	writeLines(fork, [header(OTHER_ID, "/work/other", source), entry("b1", null)]);
	const plan = planMove(source, TO, sessions, [sessions]);
	assert.deepEqual(plan.inboundLinks, [fork]);
	applyMove(plan);
	assert.equal(headerOf(fork).parentSession, plan.destFile);
});

test("a failing step puts every file back as it was", () => {
	const { child } = seedCompanions();
	const fork = join(sessions, cwdDirName("/work/other"), `2026-10-02T10-00-00-000Z_${OTHER_ID}.jsonl`);
	writeLines(fork, [header(OTHER_ID, "/work/other", source)]);
	const plan = planMove(source, TO, sessions, [sessions]);
	const blocked = join(sessions, cwdDirName(TO), "subagent-artifacts");
	writeLines(blocked, ["a file where a directory must go"]);

	assert.throws(() => applyMove(plan, "a2"));
	assert.equal(existsSync(plan.destFile), false);
	assert.ok(existsSync(child));
	assert.equal(headerOf(child).parentSession, source);
	assert.equal(headerOf(fork).parentSession, source);
	assert.deepEqual(findCompanions(join(sessions, cwdDirName(FROM)), source, ID).length, 4);
});

test("rollback after a cancelled switch restores the original layout", () => {
	const { child } = seedCompanions();
	const plan = planMove(source, TO, sessions, [sessions]);
	const applied = applyMove(plan, "a2");
	applied.rollback();
	assert.equal(existsSync(plan.destFile), false);
	assert.equal(headerOf(child).parentSession, source);
	assert.ok(existsSync(join(sessions, cwdDirName(FROM), ".pi-agent-browser-artifacts", ID)));
});

test("a leaf id pins the reopen point with a marker entry", () => {
	const plan = planMove(source, TO, sessions, [sessions]);
	applyMove(plan, "a1");
	const last = JSON.parse(readFileSync(plan.destFile, "utf8").trim().split("\n").pop() ?? "{}");
	assert.equal(last.type, "custom");
	assert.equal(last.customType, "session-relocate");
	assert.equal(last.parentId, "a1");
});

test("sessions outside the per-cwd layout only get a new cwd, in place, and no marker", () => {
	const flat = join(root, "custom-dir", FILE);
	writeLines(flat, [header(ID, FROM), entry("a1", null)]);
	const plan = planMove(flat, TO, sessions, [sessions]);
	assert.equal(plan.inPlace, true);
	assert.equal(plan.destFile, flat);
	const applied = applyMove(plan, "a1");
	assert.equal(headerOf(flat).cwd, TO);
	assert.doesNotMatch(readFileSync(flat, "utf8"), /session-relocate/);
	appendFileSync(flat, `${entry("a2", "a1")}\n`);
	applied.rollback();
	assert.equal(headerOf(flat).cwd, FROM);
	assert.match(readFileSync(flat, "utf8"), /"id":"a2"/);
});

test("planning refuses the same cwd and a taken destination before writing anything", () => {
	assert.throws(() => planMove(source, FROM, sessions, [sessions]), /already belongs/);
	writeLines(join(sessions, cwdDirName(TO), FILE), [header(ID, TO)]);
	assert.throws(() => planMove(source, TO, sessions, [sessions]), /already exists/);
});

test("a destination that appears after planning is never overwritten", () => {
	const plan = planMove(source, TO, sessions, [sessions]);
	writeLines(plan.destFile, ["someone else's file"]);
	assert.throws(() => applyMove(plan), /EEXIST/);
	assert.equal(readFileSync(plan.destFile, "utf8"), "someone else's file\n");
	assert.ok(existsSync(source));
});

test("companions follow the header id, even with underscores in it", () => {
	const id = "project_review";
	const file = join(sessions, cwdDirName(FROM), `2026-10-03T10-00-00-000Z_${id}.jsonl`);
	writeLines(file, [header(id, FROM), entry("p1", null)]);
	const dir = join(sessions, cwdDirName(FROM));
	writeLines(join(dir, ".pi-agent-browser-artifacts", id, "shot.png"), ["png"]);
	writeLines(join(dir, ".pi-agent-browser-artifacts", "review", "other.png"), ["png"]);
	applyMove(planMove(file, TO, sessions, [sessions]));
	assert.ok(existsSync(join(sessions, cwdDirName(TO), ".pi-agent-browser-artifacts", id, "shot.png")));
	assert.ok(existsSync(join(dir, ".pi-agent-browser-artifacts", "review", "other.png")));
});

test("forks nested in subfolders are relinked, and every touched session is listed for the live check", () => {
	const { child } = seedCompanions();
	const fork = join(sessions, cwdDirName("/work/other"), "forks", `2026-10-02T10-00-00-000Z_${OTHER_ID}.jsonl`);
	writeLines(fork, [header(OTHER_ID, "/work/other", source)]);
	const plan = planMove(source, TO, sessions, [sessions]);
	assert.deepEqual(plan.inboundLinks, [fork]);
	assert.ok(affectedSessionFiles(plan).includes(child));
	assert.ok(affectedSessionFiles(plan).includes(fork));
	applyMove(plan);
	assert.equal(headerOf(fork).parentSession, plan.destFile);
});

test("entries appended to the source after the copy are carried over", () => {
	const plan = planMove(source, TO, sessions, [sessions]);
	const applied = applyMove(plan);
	assert.equal(carryTail(source, plan.destFile, applied.copiedBytes), false);
	appendFileSync(source, `${entry("a3", "a2")}\n`);
	assert.equal(carryTail(source, plan.destFile, applied.copiedBytes), true);
	assert.match(readFileSync(plan.destFile, "utf8"), /"id":"a3"/);
});

test("a headerless tail at the old path merges into the moved copy", () => {
	const journal = join(root, "journal.json");
	const plan = planMove(source, TO, sessions, [sessions]);
	applyMove(plan);
	recordMove(journal, { id: ID, from: source, to: plan.destFile, movedAt: new Date().toISOString() });
	writeFileSync(source, `${entry("a3", "a2")}\n`);

	const outcomes = recoverTails(journal);
	assert.deepEqual(outcomes.map((o) => o.kind), ["merged"]);
	assert.equal(existsSync(source), false);
	assert.match(readFileSync(plan.destFile, "utf8"), /"id":"a3"/);
});

test("a file at the old path that does not chain onto the moved copy is reported, not touched", () => {
	const journal = join(root, "journal.json");
	const plan = planMove(source, TO, sessions, [sessions]);
	applyMove(plan);
	recordMove(journal, { id: ID, from: source, to: plan.destFile, movedAt: new Date().toISOString() });

	assert.deepEqual(recoverTails(journal).map((o) => o.kind), ["conflict"]);
	assert.ok(existsSync(source));
});

test("the journal drops older entries about the same files and entries past retention", () => {
	const journal = join(root, "journal.json");
	const now = Date.parse("2026-11-01T00:00:00.000Z");
	recordMove(journal, { id: "old", from: "/x/old.jsonl", to: "/y/old.jsonl", movedAt: "2026-09-01T00:00:00.000Z" }, now);
	recordMove(journal, { id: ID, from: "/a.jsonl", to: "/b.jsonl", movedAt: "2026-10-31T00:00:00.000Z" }, now);
	recordMove(journal, { id: ID, from: "/b.jsonl", to: "/a.jsonl", movedAt: "2026-10-31T01:00:00.000Z" }, now);
	assert.deepEqual(readJournal(journal).map((e) => `${e.from}>${e.to}`), ["/b.jsonl>/a.jsonl"]);
});

test("a session moved twice keeps every former path pointing at its latest home", () => {
	const journal = join(root, "journal.json");
	recordMove(journal, { id: ID, from: "/a.jsonl", to: "/b.jsonl", movedAt: new Date().toISOString() });
	recordMove(journal, { id: ID, from: "/b.jsonl", to: "/c.jsonl", movedAt: new Date().toISOString() });
	assert.deepEqual(readJournal(journal).map((e) => `${e.from}>${e.to}`).sort(), ["/a.jsonl>/c.jsonl", "/b.jsonl>/c.jsonl"]);
});

test("a torn or malformed tail is left alone and reported", () => {
	const journal = join(root, "journal.json");
	const plan = planMove(source, TO, sessions, [sessions]);
	applyMove(plan);
	recordMove(journal, { id: ID, from: source, to: plan.destFile, movedAt: new Date().toISOString() });
	const before = readFileSync(plan.destFile, "utf8");
	writeFileSync(source, `${entry("a3", "a2")}\n{"type":"message","id":"a4",`);

	assert.deepEqual(recoverTails(journal).map((o) => o.kind), ["conflict"]);
	assert.ok(existsSync(source));
	assert.equal(readFileSync(plan.destFile, "utf8"), before);
});

test("a merge ends with a newline and never duplicates entries already in the moved copy", () => {
	const journal = join(root, "journal.json");
	const plan = planMove(source, TO, sessions, [sessions]);
	applyMove(plan);
	recordMove(journal, { id: ID, from: source, to: plan.destFile, movedAt: new Date().toISOString() });
	appendFileSync(plan.destFile, `${entry("a3", "a2")}\n`);
	writeFileSync(source, `${entry("a3", "a2")}\n${entry("a4", "a3")}`);

	assert.deepEqual(recoverTails(journal).map((o) => o.kind), ["merged"]);
	const content = readFileSync(plan.destFile, "utf8");
	assert.equal(content.match(/"id":"a3"/g)?.length, 1);
	assert.match(content, /"id":"a4".*\n$/);
});
