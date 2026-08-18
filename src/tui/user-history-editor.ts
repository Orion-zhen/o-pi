import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

export type UserHistoryRecorder = (text: string) => void;

export interface InputFrameState {
	sessionName?: string;
	modelId?: string;
	modelReasoning?: boolean;
	thinkingLevel?: string;
	hasPendingMessages?: boolean;
}

export interface InputFrameOptions {
	getState(): InputFrameState;
	styleLabel(text: string): string;
	styleMode(text: string): string;
}

/** 保留 Pi 原生编辑行为和 thinking 边框色，补充上下信息线与跨会话历史。 */
export class UserHistoryEditor extends CustomEditor {
	private readonly appKeybindings: KeybindingsManager;
	private readonly record: UserHistoryRecorder;
	private readonly frame: InputFrameOptions | undefined;
	private replayQueue: string[];
	private wrappingSubmit = false;
	private capturedDuringInput: string | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		initialHistory: readonly string[],
		replayQueue: readonly string[],
		record: UserHistoryRecorder,
		frame?: InputFrameOptions,
	) {
		super(tui, theme, keybindings);
		this.appKeybindings = keybindings;
		this.record = record;
		this.frame = frame;
		this.replayQueue = replayQueue.map(normalizeText).filter((text) => text.length > 0);
		for (const text of initialHistory) super.addToHistory(text);
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
		const nativeLines = super.render(safeWidth);
		const bottomBorderIndex = findNativeBottomBorder(nativeLines);
		if (nativeLines.length < 3 || bottomBorderIndex < 1) return super.render(safeWidth);

		const state = this.frame?.getState() ?? {};
		const topLeft = cleanLabel(state.sessionName);
		const topRight = formatEngine(state);
		const bottomLeft = isBashInput(this.getText()) ? "BASH" : undefined;
		const bottomRight = state.hasPendingMessages ? "queued" : undefined;
		const body = [
			...nativeLines.slice(1, bottomBorderIndex),
			...nativeLines.slice(bottomBorderIndex + 1),
		];

		return [
			this.renderBorder(safeWidth, "top", topLeft, topRight),
			...body,
			this.renderBorder(safeWidth, "bottom", bottomLeft, bottomRight),
		];
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

	private renderBorder(
		width: number,
		position: "top" | "bottom",
		left: string | undefined,
		right: string | undefined,
	): string {
		const lineStart = "─";
		const labelStyle = position === "bottom" && left === "BASH"
			? this.frame?.styleMode
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
	const rightBudget = right === undefined ? 0 : Math.min(48, maxSingleLabelWidth, Math.max(4, Math.floor(innerWidth * 0.6)));
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
