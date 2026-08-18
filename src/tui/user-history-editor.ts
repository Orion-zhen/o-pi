import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { formatHomePage, type HomeAnimationFrame } from "./home.js";
import { HomePointerController } from "./home-pointer.js";
import type { TuiFooterSnapshot, TuiHomeConfig } from "./types.js";

const HOME_CONTENT_WIDTH = 88;
const HOME_EXTERNAL_ROWS = 2;
const INTRO_FRAME_MS = 80;
const SUBTLE_INTRO_MS = 640;
const PLAYFUL_INTRO_MS = 960;
const ORBIT_FRAME_MS = 650;

export type UserHistoryRecorder = (text: string) => void;

export interface InputFrameState {
	sessionName?: string;
	modelId?: string;
	modelProvider?: string;
	modelReasoning?: boolean;
	thinkingLevel?: string;
	availableProviderCount?: number;
	status?: string;
	hasPendingMessages?: boolean;
}

export interface InputFrameOptions {
	getState(): InputFrameState;
	styleLabel(text: string): string;
	styleMode(text: string): string;
	styleStatus?(text: string): string;
}

export interface HomeEditorOptions {
	config: TuiHomeConfig;
	getSnapshot(): TuiFooterSnapshot;
	getTheme(): Pick<Theme, "fg">;
	isVisible(): boolean;
	tip: string;
}

/** 保留 Pi 原生编辑行为和 thinking 边框色，并在空会话中承载全屏 Home。 */
export class UserHistoryEditor extends CustomEditor {
	private readonly tuiHost: TUI;
	private readonly appKeybindings: KeybindingsManager;
	private readonly record: UserHistoryRecorder;
	private readonly frame: InputFrameOptions | undefined;
	private readonly home: HomeEditorOptions | undefined;
	private readonly pointer: HomePointerController | undefined;
	private replayQueue: string[];
	private wrappingSubmit = false;
	private capturedDuringInput: string | undefined;
	private introStartedAt: number | undefined;
	private animationDeadline = 0;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private orbitTimer: ReturnType<typeof setInterval> | undefined;
	private orbitPhase = 0;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		initialHistory: readonly string[],
		replayQueue: readonly string[],
		record: UserHistoryRecorder,
		frame?: InputFrameOptions,
		home?: HomeEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.tuiHost = tui;
		this.appKeybindings = keybindings;
		this.record = record;
		this.frame = frame;
		this.home = home;
		this.pointer = home === undefined || !home.config.enabled || !home.isVisible() || tui.mode !== "fullscreen"
			? undefined
			: new HomePointerController({
				effects: home.config.pointer_effects,
				isActive: () => this.isHomeVisible(),
				requestRender: () => this.tuiHost.requestRender(),
			});
		this.replayQueue = replayQueue.map(normalizeText).filter((text) => text.length > 0);
		for (const text of initialHistory) super.addToHistory(text);
		this.startIntro();
	}

	override addToHistory(text: string): void {
		const normalized = normalizeText(text);
		if (normalized.length === 0) return;
		const expectedReplay = this.replayQueue[0];
		if (expectedReplay === normalized) {
			this.replayQueue.shift();
			return;
		}
		if (this.replayQueue.length > 0) this.replayQueue = [];
		super.addToHistory(normalized);
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const homeVisible = this.isHomeVisible();
		const editorWidth = homeVisible ? Math.min(safeWidth, HOME_CONTENT_WIDTH) : safeWidth;
		const framedEditor = this.renderFramedEditor(editorWidth, homeVisible);
		if (!homeVisible || this.home === undefined) return framedEditor;
		const height = this.tuiHost.mode === "fullscreen"
			? Math.max(framedEditor.length, this.tuiHost.terminal.rows - HOME_EXTERNAL_ROWS)
			: undefined;
		return formatHomePage(
			this.home.getSnapshot(),
			this.home.config,
			safeWidth,
			framedEditor,
			this.home.getTheme(),
			{ ...(height !== undefined ? { height } : {}), tip: this.home.tip, animation: this.getAnimationFrame() },
		);
	}

	override handleInput(data: string): void {
		if (this.wrappingSubmit) {
			super.handleInput(data);
			return;
		}
		this.wrappingSubmit = true;
		this.capturedDuringInput = undefined;
		const submit = this.onSubmit;
		const handle = (): void => {
			if (
				this.actionHandlers.has("app.message.followUp")
					&& this.appKeybindings.matches(data, "app.message.followUp")
			) this.capture(this.getExpandedText());
			super.handleInput(data);
		};
		try {
			if (submit === undefined) {
				handle();
			} else {
				const wrapper = (text: string): void => {
					this.capture(text);
					submit(text);
				};
				this.onSubmit = wrapper;
				try {
					handle();
				} finally {
					if (this.onSubmit === wrapper) this.onSubmit = submit;
				}
			}
		} finally {
			this.capturedDuringInput = undefined;
			this.wrappingSubmit = false;
		}
	}

	/** 首轮开始后释放 Home 动画并立即恢复普通编辑器高度。 */
	hideHome(): void {
		this.clearAnimation();
		this.pointer?.dispose();
		this.tuiHost.requestRender(true);
	}

	dispose(): void {
		this.clearAnimation();
		this.pointer?.dispose();
	}

	private renderFramedEditor(width: number, homeVisible: boolean): string[] {
		const nativeLines = super.render(width);
		const bottomBorderIndex = findNativeBottomBorder(nativeLines);
		if (nativeLines.length < 3 || bottomBorderIndex < 1) return nativeLines;

		const state = this.frame?.getState() ?? {};
		const topLeft = homeVisible ? "NEW SESSION" : cleanLabel(state.sessionName);
		const topRight = homeVisible ? formatHomeEngine(state) : formatEngine(state);
		const bottomLeft = homeVisible
			? formatHomeStatus(state.status)
			: isBashInput(this.getText()) ? "BASH" : undefined;
		const bottomRight = homeVisible
			? formatProviderCount(state.availableProviderCount)
			: state.hasPendingMessages ? "queued" : undefined;
		const body = [
			...nativeLines.slice(1, bottomBorderIndex),
			...nativeLines.slice(bottomBorderIndex + 1),
		];

		return [
			this.renderBorder(width, "top", topLeft, topRight),
			...body,
			this.renderBorder(width, "bottom", bottomLeft, bottomRight),
		];
	}

	private renderBorder(
		width: number,
		position: "top" | "bottom",
		left: string | undefined,
		right: string | undefined,
	): string {
		const lineStart = "─";
		const labelStyle = position === "bottom" && left === "BASH"
			? this.frame?.styleMode
			: position === "bottom" && left?.startsWith("● ")
				? this.frame?.styleStatus
				: this.frame?.styleLabel;
		const rightStyle = this.frame?.styleLabel;
		const parts = fitBorderLabels(width - 1, left, right);
		const leftPart = parts.left === undefined
			? ""
			: `─ ${labelStyle?.(parts.left) ?? parts.left} `;
		const rightPart = parts.right === undefined
			? ""
			: ` ${rightStyle?.(parts.right) ?? parts.right} ─`;
		const fillWidth = Math.max(0, width - 1 - visibleWidth(leftPart) - visibleWidth(rightPart));
		return [
			this.borderColor(lineStart),
			this.colorBorderText(leftPart),
			this.borderColor("─".repeat(fillWidth)),
			this.colorBorderText(rightPart),
		].join("");
	}

	/** 只给标签两侧的线段着色，保留标签自身的 dim/warning 样式。 */
	private colorBorderText(text: string): string {
		if (text.length === 0) return "";
		const match = text.match(/^(─?\s?)(.*?)(\s?─?)$/s);
		if (match === null) return this.borderColor(text);
		return `${this.borderColor(match[1] ?? "")}${match[2] ?? ""}${this.borderColor(match[3] ?? "")}`;
	}

	private capture(text: string): void {
		const normalized = normalizeText(text);
		if (normalized.length === 0 || this.capturedDuringInput === normalized) return;
		this.capturedDuringInput = normalized;
		super.addToHistory(normalized);
		this.record(normalized);
	}

	private isHomeVisible(): boolean {
		return this.home?.config.enabled === true && this.home.isVisible();
	}

	private startIntro(): void {
		const home = this.home;
		if (!this.isHomeVisible() || home === undefined) return;
		if (home.config.motion === "playful") this.ensureOrbitTimer();
		if (home.config.motion === "off") return;
		const now = performance.now();
		this.introStartedAt = now;
		this.animationDeadline = now + (home.config.motion === "playful" ? PLAYFUL_INTRO_MS : SUBTLE_INTRO_MS);
		this.ensureAnimationTimer();
	}

	private getAnimationFrame(): HomeAnimationFrame {
		const home = this.home;
		const pointer = this.pointer?.getFrame();
		if (home === undefined || home.config.motion === "off" || this.introStartedAt === undefined) {
			return {
				reveal: 1,
				wave: 1,
				orbit: this.orbitPhase,
				...(pointer !== undefined ? { pointer } : {}),
			};
		}
		const duration = home.config.motion === "playful" ? PLAYFUL_INTRO_MS : SUBTLE_INTRO_MS;
		const elapsed = Math.max(0, performance.now() - this.introStartedAt);
		return {
			reveal: Math.min(1, elapsed / (duration * 0.55)),
			wave: Math.min(1, Math.max(0, (elapsed - duration * 0.25) / (duration * 0.75))),
			orbit: this.orbitPhase,
			...(pointer !== undefined ? { pointer } : {}),
		};
	}

	private ensureAnimationTimer(): void {
		if (this.animationTimer !== undefined) return;
		this.animationTimer = setInterval(() => {
			if (!this.isHomeVisible() || performance.now() >= this.animationDeadline) {
				this.clearIntroTimer();
				this.tuiHost.requestRender();
				return;
			}
			this.tuiHost.requestRender();
		}, INTRO_FRAME_MS);
		this.animationTimer.unref();
	}

	private ensureOrbitTimer(): void {
		if (this.orbitTimer !== undefined) return;
		this.orbitTimer = setInterval(() => {
			if (!this.isHomeVisible()) {
				this.clearOrbitTimer();
				return;
			}
			this.orbitPhase = (this.orbitPhase + 1) % 4;
			this.tuiHost.requestRender();
		}, ORBIT_FRAME_MS);
		this.orbitTimer.unref();
	}

	private clearAnimation(): void {
		this.clearIntroTimer();
		this.clearOrbitTimer();
	}

	private clearIntroTimer(): void {
		if (this.animationTimer === undefined) return;
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	private clearOrbitTimer(): void {
		if (this.orbitTimer === undefined) return;
		clearInterval(this.orbitTimer);
		this.orbitTimer = undefined;
	}
}

function findNativeBottomBorder(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 1; index -= 1) {
		const plain = stripTerminalSequences(lines[index] ?? "");
		if (/^─+$/.test(plain) || /^─+ [↑↓] \d+ more ─*$/.test(plain)) return index;
	}
	return -1;
}

function fitBorderLabels(
	innerWidth: number,
	left: string | undefined,
	right: string | undefined,
): { left?: string; right?: string } {
	if (innerWidth < 7) return {};
	const maxSingleLabelWidth = innerWidth - 4;
	const rightBudget = right === undefined ? 0 : Math.min(52, maxSingleLabelWidth, Math.max(4, Math.floor(innerWidth * 0.62)));
	const fittedRight = right === undefined || rightBudget < 4 ? undefined : truncateToWidth(right, rightBudget, "…");
	const rightWidth = fittedRight === undefined ? 0 : visibleWidth(fittedRight) + 3;
	const leftBudget = Math.max(0, innerWidth - rightWidth - 4);
	const fittedLeft = left === undefined || leftBudget < 4 ? undefined : truncateToWidth(left, leftBudget, "…");
	return {
		...(fittedLeft !== undefined && fittedLeft.length > 0 ? { left: fittedLeft } : {}),
		...(fittedRight !== undefined && fittedRight.length > 0 ? { right: fittedRight } : {}),
	};
}

function formatEngine(state: InputFrameState): string | undefined {
	const model = cleanLabel(state.modelId);
	if (model === undefined) return undefined;
	const thinking = state.modelReasoning ? cleanLabel(state.thinkingLevel) : undefined;
	return thinking === undefined ? model : `${model} · ${thinking}`;
}

function formatHomeEngine(state: InputFrameState): string | undefined {
	const engine = formatEngine(state);
	if (engine === undefined) return undefined;
	const provider = cleanLabel(state.modelProvider);
	return provider === undefined ? engine : `${provider} / ${engine}`;
}

function formatHomeStatus(status: string | undefined): string | undefined {
	const clean = cleanLabel(status);
	return clean === undefined ? undefined : `● ${clean}`;
}

function formatProviderCount(count: number | undefined): string | undefined {
	if (count === undefined || count <= 0) return undefined;
	return `${count} provider${count === 1 ? "" : "s"}`;
}

function cleanLabel(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const clean = stripTerminalSequences(value).replace(/[\r\n\t]+/g, " ").trim();
	return clean.length > 0 ? clean : undefined;
}

function isBashInput(text: string): boolean {
	return text.trimStart().startsWith("!");
}

function normalizeText(text: string): string {
	return text.trim();
}
