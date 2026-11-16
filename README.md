# @clementprevot/pi-session-relocate

A [Pi](https://pi.dev) extension that moves a session to another working directory without losing anything: same session id, full history, subagent runs, and the links other sessions hold to it. Use it when an agent started in a repository, created a worktree, and did its work there, so the session now sits under the wrong directory in `/resume`.

- `/migrate`, from the directory where the session belongs: pick a session from another directory, then move it here or copy it here
- `/move [path]`, from inside the session: send it to another directory, picked from the repository's worktrees, the directories the conversation used, or a path you type

## Install

```bash
pi install npm:@clementprevot/pi-session-relocate
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch, or run `/reload`).

## Bring a session here with /migrate

Run `/migrate` in the directory the session should belong to. The picker lists the sessions of other directories:

- with [@clementprevot/pi-session-search](https://github.com/clementprevot/pi-session-search) installed, you get its full-text search over prompts and answers, archived sessions included
- without it, you get a list filtered by name or first message, scoped to the worktrees of the current repository (tab shows every directory)

Then choose what to do with the session you picked:

- Move here: the same session, with the same id, now belongs to this directory and leaves the old one
- Copy here: Pi forks it into a new session here, and the original stays where it was

## Send the current session away with /move

Run `/move` in the session itself. It offers the other worktrees of the repository first, then the directories the conversation worked in (`cd`, `git worktree add`, tool `cwd` arguments), then a typed path. `/move <path>` skips the list and autocompletes directories as you type.

Pi then reopens the session in the new directory, without a restart, and loads that directory's context files, settings and skills.

## What a move changes

A move rewrites the `cwd` in the session header and moves the file to the target's sessions directory, keeping its id and file name. Everything that belongs to the session moves with it:

- its subagent runs (the `<session>/` folder beside the file), whose child sessions are relinked to the new path
- its subagent artifacts and agent-browser screenshots
- the forks and clones that name it as their parent, which are relinked wherever they live, the session archive included

The original file goes to the system trash (`trash`, `gio trash` or `trash-put`). Without a trash command, it goes to `~/.pi/agent/session-relocate/trash/`. Nothing is ever deleted outright.

Sessions stored in a custom session directory (`--session-dir`, `PI_CODING_AGENT_SESSION_DIR`) stay where they are and only get the new `cwd`.

## Safety

A move happens in two steps, so it never leaves a session half moved:

1. The extension writes the moved copy, moves the companions and relinks the other sessions, while the original stays untouched. It never overwrites a file that already exists at the destination. If any step fails, it undoes the steps already done.
2. It switches to the moved session. Only once the moved session has started does the original go to the trash. A cancelled switch puts every file back. If a switch fails after the old session closed, the extension keeps both copies and deletes neither.

The move completes even when the target directory does not load this extension, for example with a project-local install.

Pi has no lock on session files and keeps appending to whatever path it has open, so the extension refuses to move a session that is still in use:

- open in another Pi process: every Pi that loads this extension registers the session it has open, and a move is refused while that session, or one of its subagent runs or forks, is open elsewhere
- with background subagent runs still active: wait for them, or stop them first
- written in the last two minutes: the confirmation warns you, in case a Pi without this extension has it open

These checks run again after you confirm, since things can change while the dialog is open.

Pi can still write a few entries to the old file while the old session closes. The extension carries them over to the moved copy and reopens it, so the conversation includes them. If entries reach the old path later, the next session start appends them to the moved copy, skipping any it already has. A file there that does not cleanly continue the moved session, or holds a torn line, is reported and left alone.

pi-subagents keeps some state by session path: background run records and missions. The confirmation says when that state exists. The moved session still works, but resuming those older runs from it may not.

## For other extensions

After each move, the extension emits `session-relocate:v1:moved` on Pi's event bus with `{ id, from, to, fromCwd, toCwd }`, so extensions that index sessions by path can update their records.

## Configuration

None.

## Privacy and data

Everything stays on your machine. The extension reads and writes only Pi's sessions tree, the session archive, and its own state in `~/.pi/agent/session-relocate/` (the registry of open sessions and a journal of the last 30 days of moves). It runs `git worktree list` and the trash command, and makes no network calls.

## Local development

```bash
npm install
npm test
npm run typecheck
```

To try the extension in a live session without installing it:

```bash
pi -e /path/to/this/repo
```

## Credits

The companion handling and the recovery of late writes come from [@clementprevot/pi-session-archive](https://github.com/clementprevot/pi-session-archive). [pi-move](https://github.com/k3-2o/pi-move) and [pi-move-session](https://github.com/w-winter/dot314) showed the in-place switch and the family relinking.

## License

[MIT](LICENSE)
