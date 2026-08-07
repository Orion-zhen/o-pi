import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export type UserHistoryRecorder = (text: string) => void;

/** 保留 Pi 原生编辑行为，只补充跨会话历史预载和所有键盘提交的记录。 */
export class UserHistoryEditor extends CustomEditor {
	private readonly appKeybindings: KeybindingsManager;
	private readonly record: UserHistoryRecorder;
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
	) {
		super(tui, theme, keybindings);
		this.appKeybindings = keybindings;
		this.record = record;
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

	private capture(text: string): void {
		const normalized = normalizeText(text);
		if (normalized.length === 0 || this.capturedDuringInput === normalized) return;
		this.capturedDuringInput = normalized;
		super.addToHistory(normalized);
		this.record(normalized);
	}
}

function normalizeText(text: string): string {
	return text.trim();
}
