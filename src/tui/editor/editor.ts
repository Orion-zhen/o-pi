import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { normalizeHistoryText } from "../../harness/user-history.ts";
import { formatHomePage, HOME_CONTENT_WIDTH } from "../views/home/home.ts";
import { HomeAnimation } from "../views/home/animation.ts";
import type { TuiSnapshot, TuiHomeConfig } from "../shell/types.ts";

const HOME_EXTERNAL_ROWS = 2;

interface HomeEditorOptions {
	config: TuiHomeConfig;
	isVisible(): boolean;
	onSubmit(): void;
	tip: string;
}

interface SessionEditorOptions {
	initialHistory: readonly string[];
	replayHistory: readonly string[];
	record(text: string): void;
	getSnapshot(): TuiSnapshot;
	getTheme(): Pick<Theme, "fg">;
	/** 只为启用的 Home 提供选项。 */
	home?: HomeEditorOptions;
}

/** 原生编辑器只增强历史、边框标签和 fullscreen Home，补全与滚动布局仍由 Pi 管理。 */
export class SessionEditor extends CustomEditor {
	private readonly fullscreenHome: { options: HomeEditorOptions; animation: HomeAnimation } | undefined;
	private replayQueue: string[];
	private handlingInput = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly options: SessionEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.replayQueue = options.replayHistory.map((text) => text.trim()).filter((text) => text.length > 0);
		for (const text of options.initialHistory) super.addToHistory(normalizeHistoryText(text));
		const home = options.home;
		this.fullscreenHome = tui.mode === "fullscreen" && home?.isVisible()
			? { options: home, animation: new HomeAnimation(tui, home.config, () => this.getFullscreenHome() !== undefined) }
			: undefined;
	}

	override addToHistory(text: string): void {
		const normalized = text.trim();
		if (normalized.length === 0) return;
		if (!this.handlingInput && this.replayQueue[0] === normalized) {
			this.replayQueue.shift();
			return;
		}
		this.replayQueue = [];
		const entry = normalizeHistoryText(normalized);
		if (!entry) return;
		super.addToHistory(entry);
		if (this.handlingInput) this.options.record(entry);
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const home = this.getFullscreenHome();
		const lines = super.render(home === undefined ? safeWidth : Math.min(safeWidth, HOME_CONTENT_WIDTH));
		if (home === undefined) return lines;
		return formatHomePage(this.options.getSnapshot(), home.options.config, safeWidth, lines, this.options.getTheme(), {
			height: Math.max(lines.length, this.tui.terminal.rows - HOME_EXTERNAL_ROWS),
			tip: home.options.tip,
			animation: home.animation.getFrame(),
		});
	}

	override handleInput(data: string): void {
		// Pi 在真实提交或排队时同步调用 addToHistory，导航回放不应写入磁盘。
		this.handlingInput = true;
		const submit = this.onSubmit;
		const home = this.options.home;
		const wrapper = submit && home?.isVisible() ? (text: string) => {
			if (text.trim()) home.onSubmit();
			submit(text);
		} : undefined;
		if (wrapper) this.onSubmit = wrapper;
		try {
			super.handleInput(data);
		} finally {
			this.handlingInput = false;
			if (submit && wrapper && this.onSubmit === wrapper) this.onSubmit = submit;
		}
	}

	hideHome(): void {
		this.dispose();
		this.tui.requestRender(true);
	}

	dispose(): void {
		this.fullscreenHome?.animation.dispose();
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
		const snapshot = this.options.getSnapshot();
		const home = this.getFullscreenHome() !== undefined;
		const engine = formatEngine(snapshot);
		const provider = home ? cleanLabel(snapshot.modelProvider) : undefined;
		return this.renderBorder(
			width,
			home ? "NEW SESSION" : cleanLabel(snapshot.sessionName),
			engine !== undefined && provider !== undefined ? `${provider} / ${engine}` : engine,
			"dim",
		);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0) return super.renderBottomBorder(width, hiddenLineCount);
		const snapshot = this.options.getSnapshot();
		if (this.getFullscreenHome() !== undefined) {
			const count = snapshot.availableProviderCount;
			const providers = count > 0 ? `${count} provider${count === 1 ? "" : "s"}` : undefined;
			return this.renderBorder(width, `● ${snapshot.status}`, providers, "success");
		}
		const bash = this.getText().trimStart().startsWith("!");
		return this.renderBorder(width, bash ? "BASH" : undefined, snapshot.hasPendingMessages ? "queued" : undefined, bash ? "warning" : "dim");
	}

	private renderBorder(width: number, left: string | undefined, right: string | undefined, leftColor: "dim" | "warning" | "success"): string {
		const labels = fitBorderLabels(width - 1, left, right);
		const theme = this.options.getTheme();
		const leftPart = labels.left === undefined
			? "" : `${this.borderColor("─ ")}${theme.fg(leftColor, labels.left)}${this.borderColor(" ")}`;
		const rightPart = labels.right === undefined
			? "" : `${this.borderColor(" ")}${theme.fg("dim", labels.right)}${this.borderColor(" ─")}`;
		const fill = Math.max(0, width - 1 - visibleWidth(leftPart) - visibleWidth(rightPart));
		return `${this.borderColor("─")}${leftPart}${this.borderColor("─".repeat(fill))}${rightPart}`;
	}

	private getFullscreenHome() {
		const home = this.fullscreenHome;
		return home?.options.isVisible() ? home : undefined;
	}
}

function fitBorderLabels(innerWidth: number, left: string | undefined, right: string | undefined): { left?: string; right?: string } {
	if (innerWidth < 7) return {};
	const rightBudget = Math.min(52, innerWidth - 4, Math.max(4, Math.floor(innerWidth * 0.62)));
	const fittedRight = right === undefined ? undefined : truncateToWidth(right, rightBudget, "…");
	const rightWidth = fittedRight === undefined ? 0 : visibleWidth(fittedRight) + 3;
	const leftBudget = innerWidth - rightWidth - 4;
	const fittedLeft = left === undefined || leftBudget < 4 ? undefined : truncateToWidth(left, leftBudget, "…");
	return {
		...(fittedLeft === undefined ? {} : { left: fittedLeft }),
		...(fittedRight === undefined ? {} : { right: fittedRight }),
	};
}

function formatEngine(snapshot: TuiSnapshot): string | undefined {
	const model = cleanLabel(snapshot.modelId);
	if (model === undefined) return undefined;
	const routed = snapshot.routedModel;
	const speed = snapshot.codexSpeed;
	const selected = speed === null || speed === "normal" ? model : `${model} ${speed}`;
	let label = routed ? `${selected} → ${cleanLabel(`${routed.provider}/${routed.id}`)}` : selected;
	const response = cleanLabel(snapshot.responseModel);
	if (response && response !== (routed?.id ?? snapshot.modelId)) label += ` → ${response}`;
	const thinking = routed ? cleanLabel(routed.thinkingLevel) : snapshot.modelReasoning ? cleanLabel(snapshot.thinkingLevel) : undefined;
	return thinking === undefined ? label : `${label} · ${thinking}`;
}

function cleanLabel(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const clean = stripTerminalSequences(value).replace(/[\r\n\t]+/g, " ").trim();
	return clean.length > 0 ? clean : undefined;
}
