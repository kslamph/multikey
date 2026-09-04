/**
 * TUI helpers in the npm:better-custom style: searchable single-select list,
 * read-only info panel, built on ctx.ui.custom + @earendil-works/pi-tui.
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface SelectItem {
	value: string;
	label: string;
	suffix?: string;
	description?: string;
}

type CommandContext = Parameters<Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export async function selectOne(
	ctx: CommandContext,
	title: string,
	items: SelectItem[],
	options?: { initialIndex?: number },
): Promise<string | null> {
	if (items.length === 0) return null;

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let cursor = Math.max(0, Math.min(options?.initialIndex ?? 0, items.length - 1));
		let query = "";
		let cachedLines: string[] | undefined;
		const maxVisible = 12;

		function visible(): SelectItem[] {
			const q = query.trim().toLowerCase();
			if (!q) return items;
			return items.filter((item) =>
				`${item.label} ${item.suffix ?? ""} ${item.description ?? ""}`.toLowerCase().includes(q),
			);
		}

		function refresh() {
			const v = visible();
			if (v.length === 0) cursor = 0;
			else if (cursor >= v.length) cursor = v.length - 1;
			cachedLines = undefined;
			tui.requestRender();
		}

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const v = visible();
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				const border = theme.fg("accent", "─".repeat(w));

				add(border);
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add(` ${theme.fg("text", `Search: ${query || "-"}`)}`);
				add();

				if (v.length === 0) {
					add(theme.fg("warning", " No matches."));
				} else {
					const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, v.length - maxVisible)));
					const end = Math.min(v.length, start + maxVisible);
					for (let i = start; i < end; i++) {
						const item = v[i]!;
						const active = i === cursor;
						const prefix = active ? theme.fg("accent", "> ") : "  ";
						const label = active ? theme.fg("accent", item.label) : theme.fg("text", item.label);
						const suffix = item.suffix ? theme.fg("dim", item.suffix) : "";
						add(`${prefix}${label}${suffix}`);
						if (item.description) {
							for (const line of item.description.split("\n")) {
								add(`   ${theme.fg("muted", line)}`);
							}
						}
					}
					if (v.length > maxVisible) {
						add();
						add(theme.fg("dim", ` ${start + 1}-${end} of ${v.length}`));
					}
				}

				add();
				add(theme.fg("dim", " Type to search • ↑↓ move • enter confirm • backspace delete • esc cancel"));
				add(border);

				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				const v = visible();
				if (matchesKey(data, Key.up)) {
					if (v.length === 0) return;
					cursor = cursor === 0 ? v.length - 1 : cursor - 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (v.length === 0) return;
					cursor = cursor === v.length - 1 ? 0 : cursor + 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(v[cursor]?.value ?? null);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (data === "\u007f" || data === "\b") {
					if (query.length > 0) {
						query = query.slice(0, -1);
						refresh();
					}
					return;
				}
				if (data >= " " && data !== "\u001b" && data !== "\r" && data !== "\n") {
					query += data;
					cursor = 0;
					refresh();
				}
			},
		};
	});
}

export async function showInfo(ctx: CommandContext, title: string, lines: string[]): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let cachedLines: string[] | undefined;
		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const w = Math.max(10, width);
				const out: string[] = [];
				const add = (line = "") => out.push(truncateToWidth(line, w));
				const border = theme.fg("accent", "─".repeat(w));
				add(border);
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				for (const line of lines) add(` ${line}`);
				add();
				add(theme.fg("dim", " esc/enter close"));
				add(border);
				cachedLines = out;
				return out;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
			},
		};
	});
}

export interface InfoPanelHandle {
	/** Resolves when the panel closes (user enter/esc, or close()). */
	closed: Promise<void>;
	/** Close the panel programmatically; no-op if the user already dismissed it. */
	close(): void;
}

/**
 * Non-blocking variant of {@link showInfo}: returns a handle immediately so the
 * caller can auto-close the panel when something finishes (e.g. an OAuth device
 * flow detects browser approval) while the user can still dismiss it manually.
 * Dismissing the panel never cancels whatever is running behind it.
 */
export function showInfoWithHandle(ctx: CommandContext, title: string, lines: string[]): InfoPanelHandle {
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	let doneFn: (() => void) | undefined;
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		try {
			doneFn?.();
		} catch {
			// Panel may already be gone; the closed promise is what matters.
		}
		resolveClosed?.();
	};

	void ctx.ui.custom<void>((tui, theme, _kb, done) => {
		doneFn = done;
		let cachedLines: string[] | undefined;
		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const w = Math.max(10, width);
				const out: string[] = [];
				const add = (line = "") => out.push(truncateToWidth(line, w));
				const border = theme.fg("accent", "─".repeat(w));
				add(border);
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				for (const line of lines) add(` ${line}`);
				add();
				add(theme.fg("dim", " esc/enter dismiss (keeps running)"));
				add(border);
				cachedLines = out;
				return out;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) finish();
			},
		};
	});

	return { closed, close: finish };
}

/** Simple toggle list (multi-select), returns selected values or null on cancel. */
export async function pickMany(
	ctx: CommandContext,
	title: string,
	items: SelectItem[],
	options?: { preselected?: string[] },
): Promise<string[] | null> {
	return await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		let query = "";
		const selected = new Set<string>(options?.preselected ?? []);
		let cachedLines: string[] | undefined;
		const maxVisible = 12;

		function visible(): SelectItem[] {
			const q = query.trim().toLowerCase();
			if (!q) return items;
			return items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(q));
		}

		function refresh() {
			const v = visible();
			if (v.length === 0) cursor = 0;
			else if (cursor >= v.length) cursor = v.length - 1;
			cachedLines = undefined;
			tui.requestRender();
		}

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const v = visible();
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				const border = theme.fg("accent", "─".repeat(w));
				add(border);
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add(` ${theme.fg("text", `Search: ${query || "-"}`)}`);
				add();
				if (v.length === 0) {
					add(theme.fg("warning", " No matches."));
				} else {
					for (let i = 0; i < Math.min(v.length, maxVisible); i++) {
						const item = v[i]!;
						const active = i === cursor;
						const check = selected.has(item.value) ? theme.fg("accent", "✓") : " ";
						const prefix = active ? theme.fg("accent", "> ") : "  ";
						add(`${prefix}[${check}] ${active ? theme.fg("accent", item.label) : item.label}`);
					}
				}
				add();
				add(theme.fg("dim", " space toggle • enter confirm • esc cancel"));
				add(border);
				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				const v = visible();
				if (matchesKey(data, Key.up)) {
					if (v.length === 0) return;
					cursor = cursor === 0 ? v.length - 1 : cursor - 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (v.length === 0) return;
					cursor = cursor === v.length - 1 ? 0 : cursor + 1;
					refresh();
					return;
				}
				if (data === " ") {
					const item = v[cursor];
					if (item) {
						if (selected.has(item.value)) selected.delete(item.value);
						else selected.add(item.value);
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done([...selected]);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (data === "\u007f" || data === "\b") {
					if (query.length > 0) {
						query = query.slice(0, -1);
						refresh();
					}
					return;
				}
				if (data >= " " && data !== "\u001b" && data !== "\r" && data !== "\n") {
					query += data;
					cursor = 0;
					refresh();
				}
			},
		};
	});
}

export async function inputNumber(ctx: CommandContext, title: string, current: number): Promise<number | undefined> {
	const raw = await ctx.ui.input(title, String(current));
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Run an async task behind a live status panel: `update(line)` appends progress
 * lines while the task runs; the panel closes itself with the task's result.
 */
export async function withProgress<T>(
	ctx: CommandContext,
	title: string,
	task: (update: (line: string) => void) => Promise<T>,
): Promise<T> {
	return await ctx.ui.custom<T>((tui, theme, _kb, done) => {
		const lines: string[] = [];
		let finished = false;
		let cachedLines: string[] | undefined;
		let frame = 0;
		const spinner = setInterval(() => {
			if (finished) return;
			frame = (frame + 1) % SPINNER_FRAMES.length;
			tui.requestRender();
		}, 90);

		function update(line: string) {
			lines.push(line);
			cachedLines = undefined;
			tui.requestRender();
		}

		void (async () => {
			try {
				const result = await task(update);
				finished = true;
				clearInterval(spinner);
				done(result);
			} catch (error) {
				finished = true;
				clearInterval(spinner);
				update(`error: ${error instanceof Error ? error.message : String(error)}`);
				// Give the user a moment to see the error before the panel closes.
				setTimeout(() => done(undefined as T), 2500);
			}
		})();

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const w = Math.max(10, width);
				const out: string[] = [];
				const add = (line = "") => out.push(truncateToWidth(line, w));
				const border = theme.fg("accent", "─".repeat(w));
				add(border);
				add(` ${theme.fg("accent", theme.bold(title))} ${finished ? "" : theme.fg("accent", SPINNER_FRAMES[frame]!)}`);
				add();
				for (const line of lines) add(` ${theme.fg("dim", line)}`);
				add();
				add(theme.fg("dim", " working — please wait…"));
				add(border);
				cachedLines = out;
				return out;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput() {
				// Input intentionally ignored while the task runs.
				if (finished) done(undefined as T);
			},
		};
	});
}
