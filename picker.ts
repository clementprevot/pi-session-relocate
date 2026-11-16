/**
 * Fallback session picker for /migrate when no search picker answers: the
 * sessions of other directories, scoped to the current repository's worktrees
 * by default (tab toggles all), filtered as you type on name or first message.
 */
import { DynamicBorder, getSelectListTheme, type SessionInfo, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { resolve } from "node:path";

const MAX_VISIBLE = 12;

type Scope = "repo" | "all";
type SortMode = "date" | "name";

export function displayName(session: SessionInfo): string {
	const name = (session.name ?? "").trim() || session.firstMessage.trim() || "(unnamed)";
	const line = name.replaceAll("\n", " ");
	return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}

export function relativeTime(date: Date): string {
	const sec = Math.floor((Date.now() - date.getTime()) / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
}

/** Sessions born in another directory than `cwd`, newest first; `repoDirs` scopes them to the repo's worktrees. */
export function migrationCandidates(sessions: SessionInfo[], cwd: string, repoDirs: string[] | undefined): SessionInfo[] {
	const here = resolve(cwd);
	const repo = repoDirs ? new Set(repoDirs.map((dir) => resolve(dir))) : undefined;
	return sessions
		.filter((s) => s.cwd && resolve(s.cwd) !== here && (!repo || repo.has(resolve(s.cwd))))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export class MigratePicker implements Component {
	private readonly sessions: SessionInfo[];
	private readonly cwd: string;
	private readonly repoDirs: string[] | undefined;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly kb: KeybindingsManager;
	private readonly search = new Input({ prompt: "filter: " });
	private readonly onSelect: (session: SessionInfo) => void;
	private readonly onCancel: () => void;
	private scope: Scope;
	private sortMode: SortMode = "date";
	private filtered: SelectItem[] = [];
	private byPath = new Map<string, SessionInfo>();
	private list: SelectList;
	private selectedIndex = 0;

	constructor(options: {
		sessions: SessionInfo[];
		cwd: string;
		/** Worktrees of the current repository; undefined outside a git repository. */
		repoDirs: string[] | undefined;
		theme: Theme;
		tui: TUI;
		keybindings: KeybindingsManager;
		onSelect: (session: SessionInfo) => void;
		onCancel: () => void;
	}) {
		this.sessions = options.sessions;
		this.cwd = options.cwd;
		this.repoDirs = options.repoDirs;
		this.theme = options.theme;
		this.tui = options.tui;
		this.kb = options.keybindings;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		const inRepo = this.repoDirs ? migrationCandidates(this.sessions, this.cwd, this.repoDirs) : [];
		this.scope = inRepo.length > 0 ? "repo" : "all";
		this.list = this.buildList();
	}

	private visible(): SessionInfo[] {
		const query = this.search.getValue().trim().toLowerCase();
		let items = migrationCandidates(this.sessions, this.cwd, this.scope === "repo" ? this.repoDirs : undefined);
		if (query) {
			items = items.filter(
				(s) => displayName(s).toLowerCase().includes(query) || s.firstMessage.toLowerCase().includes(query),
			);
		}
		if (this.sortMode === "name") items = [...items].sort((a, b) => displayName(a).localeCompare(displayName(b)));
		return items;
	}

	private buildList(): SelectList {
		const items = this.visible();
		this.filtered = items.map((s) => ({
			value: s.path,
			label: displayName(s),
			description: `${relativeTime(s.modified)}  ·  ${s.cwd}`,
		}));
		this.byPath = new Map(items.map((s) => [s.path, s]));
		this.selectedIndex = 0;
		const list = new SelectList(this.filtered, MAX_VISIBLE, getSelectListTheme());
		list.onSelect = (item) => {
			const session = this.byPath.get(item.value);
			if (session) this.onSelect(session);
		};
		list.onCancel = () => this.onCancel();
		return list;
	}

	private rebuild(): void {
		this.list = this.buildList();
		this.tui.requestRender();
	}

	/** Mouse wheel and clicks move SelectList's internal index; keep the mirror in sync. */
	private syncIndex(): void {
		const selected = this.list.getSelectedItem();
		this.selectedIndex = selected ? this.filtered.findIndex((i) => i.value === selected.value) : 0;
	}

	private moveSelection(delta: number): void {
		const target = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
		this.list.setSelectedIndex(target);
		this.selectedIndex = target;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "app.session.toggleSort")) {
			this.sortMode = this.sortMode === "date" ? "name" : "date";
			this.rebuild();
			return;
		}
		if (this.kb.matches(data, "tui.input.tab")) {
			if (this.repoDirs) this.scope = this.scope === "repo" ? "all" : "repo";
			this.rebuild();
			return;
		}
		if (this.kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE);
			return;
		}
		if (this.kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE);
			return;
		}
		if (
			this.kb.matches(data, "tui.select.up") ||
			this.kb.matches(data, "tui.select.down") ||
			this.kb.matches(data, "tui.select.confirm") ||
			this.kb.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
			this.syncIndex();
			this.tui.requestRender();
			return;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (this.search.getValue() !== before) this.rebuild();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.list.handleMouse(event);
		this.syncIndex();
		if (result?.render) this.tui.requestRender();
		return result;
	}

	invalidate(): void {
		this.list = this.buildList();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = (s: string) => this.theme.fg("accent", s);
		lines.push(...new DynamicBorder(border).render(width));
		const scopeLabel = this.scope === "repo" ? "this repository" : "all";
		const sortLabel = this.sortMode === "date" ? "date" : "name";
		const header = `${this.theme.fg("accent", this.theme.bold("Bring a session here"))}  ${this.theme.fg(
			"dim",
			`(${this.filtered.length} · scope: ${scopeLabel} · sort: ${sortLabel})`,
		)}`;
		lines.push(...new Text(header, 1, 0).render(width));
		lines.push(...this.search.render(width));
		if (this.filtered.length === 0) {
			lines.push(...new Text(this.theme.fg("muted", "No session from another directory matches."), 1, 0).render(width));
		} else {
			lines.push(...this.list.render(width));
		}
		const tabHint = this.repoDirs ? "tab scope · " : "";
		lines.push(
			...new Text(this.theme.fg("dim", `type to filter · ${tabHint}ctrl+s sort · enter select · esc cancel`), 1, 0).render(width),
		);
		lines.push(...new DynamicBorder(border).render(width));
		return lines;
	}
}
