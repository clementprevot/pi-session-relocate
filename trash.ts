import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

const TRASH_COMMANDS: Array<[string, string[]]> = [
	["trash", []],
	["gio", ["trash"]],
	["trash-put", []],
];

/**
 * Send a file to the system trash so a move can always be undone by hand.
 * Without a trash CLI (bare Linux, CI), the file goes to `fallbackDir` instead
 * of being deleted. Returns where the file went, for the user message.
 */
export function trashFile(path: string, fallbackDir: string): string {
	for (const [command, args] of TRASH_COMMANDS) {
		// No "--": macOS's trash treats it as a file name; callers pass absolute paths, never a leading dash.
		const result = spawnSync(command, [...args, path], { encoding: "utf8" });
		if (!result.error && result.status === 0) return "the trash";
	}
	mkdirSync(fallbackDir, { recursive: true });
	const target = join(fallbackDir, `${Date.now()}-${basename(path)}`);
	renameSync(path, target);
	return target;
}
