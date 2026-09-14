import { KeybindingsManager, useWindowsKeybindings } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ProcessTerminal, stripTerminalSequences, TuiAltScreen, TuiMainScreen, visibleWidth, type EditorTheme, type TuiMode } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEditor } from "../../../src/tui/editor/editor.js";
import { useTempDir } from "../../helpers/lifecycle.js";
import { defaultTuiConfig, plainTheme, tuiSnapshot } from "../shell/fixtures.js";

const temp = useTempDir("o-pi-session-editor-");
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("会话编辑器", () => {
	it("上下键跨会话导航，每次键盘提交只记录一次", () => {
		const record = vi.fn();
		const editor = createEditor({ initialHistory: ["older", "current"], replayHistory: ["older", "current"], record });
		editor.addToHistory("older");
		editor.addToHistory("current");
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("current");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older");
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("current");
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("");
		editor.onSubmit = (text) => editor.addToHistory(text);
		editor.setText(" /settings ");
		editor.handleInput("\r");
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith("/settings");
	});

	it("输入框直线展示会话、模型、thinking 和条件状态", () => {
		const editor = createEditor({ getSnapshot: () => tuiSnapshot({
			sessionName: "Refactor TUI", modelId: "gpt-5.6-sol", modelReasoning: true, thinkingLevel: "high", hasPendingMessages: true,
		}) });
		editor.setText("!npm test");
		const lines = editor.render(80).map(stripTerminalSequences);
		expect(lines[0]).toMatch(/^── Refactor TUI .*gpt-5\.6-sol · high ─$/);
		expect(lines.at(-1)).toMatch(/^── BASH .* queued ─$/);
		expect(lines.slice(1, -1).every((line) => !line.startsWith("│") && !line.endsWith("│"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
	});

	it("fullscreen Home 共享输入框快照，隐藏后恢复普通高度", () => {
		let visible = true;
		const editor = createEditor({
			getSnapshot: () => tuiSnapshot({
				cwd: "/repo", git: "main", modelId: "gpt-5.6-sol", modelProvider: "openai", modelReasoning: true, thinkingLevel: "xhigh", availableProviderCount: 2,
				context: { tokens: 0, contextWindow: 200_000, percent: 0 },
				tools: { activeNames: ["read"], allNames: ["read", "grep"] }, skills: { totalCount: 2, modelInvocableCount: 1 },
			}),
			home: { config: { ...defaultTuiConfig().home, motion: "off" }, isVisible: () => visible, onSubmit: vi.fn(), tip: "Use @ to attach files." },
		}, "fullscreen");
		const output = editor.render(100).map(stripTerminalSequences).join("\n");
		for (const text of ["NEW SESSION", "openai / gpt-5.6-sol · xhigh", "● ready", "2 providers", "1/2 tools", "CAPABILITIES"]) expect(output).toContain(text);
		visible = false;
		editor.hideHome();
		const chat = editor.render(100).map(stripTerminalSequences);
		expect(chat).toHaveLength(3);
		expect(chat.join("\n")).not.toContain("NEW SESSION");
	});

	it("regular 启动横幅不扩展输入框，提交时仍退出启动态", () => {
		let visible = true;
		const onSubmit = vi.fn(() => { visible = false; });
		const editor = createEditor({ home: { config: defaultTuiConfig().home, isVisible: () => visible, onSubmit, tip: "tip" } });
		const submit = vi.fn();
		editor.onSubmit = submit;
		expect(editor.render(100)).toHaveLength(3);
		editor.setText("hello");
		editor.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledOnce();
		expect(submit).toHaveBeenCalledWith("hello");
	});

	it("fullscreen Home 不因键盘输入闪烁", () => {
		const editor = createEditor({
			getTheme: () => ({ fg: (name, text) => `<${name}>${text}</${name}>` }),
			home: { config: { ...defaultTuiConfig().home, pointer_effects: "off" }, isVisible: () => true, onSubmit: vi.fn(), tip: "tip" },
		}, "fullscreen");
		try {
			editor.handleInput("a");
			expect(editor.render(100).join("\n")).not.toContain("<warning>");
		} finally {
			editor.dispose();
		}
	});

	it.each(["regular", "fullscreen"] as const)("%s 只为可见 Home 请求动画重绘，退出后停止", async (mode) => {
		vi.useFakeTimers();
		const render = vi.spyOn(mode === "regular" ? TuiMainScreen.prototype : TuiAltScreen.prototype, "requestRender").mockImplementation(() => {});
		let visible = true;
		const editor = createEditor({ home: { config: { ...defaultTuiConfig().home, pointer_effects: "off" }, isVisible: () => visible, onSubmit: vi.fn(), tip: "tip" } }, mode);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(render.mock.calls.length > 0).toBe(mode === "fullscreen");
		visible = false;
		editor.hideHome();
		render.mockClear();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(render).not.toHaveBeenCalled();
	});

	it.each([120, 80, 40, 20, 12])("宽度 %i 下输入框不越界", (width) => {
		const editor = createEditor({ getSnapshot: () => tuiSnapshot({ sessionName: "A very long session name", modelId: "gpt-5.6-sol", modelReasoning: true, thinkingLevel: "xhigh" }) });
		editor.setText("一段用于检查窄屏换行的输入");
		expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("保留原生滚动提示，不通过边框标签隐藏溢出行数", () => {
		const editor = createEditor();
		editor.setText(Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"));
		const output = editor.render(80).map(stripTerminalSequences).join("\n");
		expect(output).toMatch(/↑ \d+ more/);
	});

	it("补全列表位于原生下边框之后，选择候选仍可提交", async () => {
		const editor = createEditor();
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({ items: [{ value: "/help", label: "/help" }], prefix: "/h" }),
			applyCompletion: () => ({ lines: ["/help"], cursorLine: 0, cursorCol: 5 }),
		});
		editor.setText("/h");
		editor.handleInput("\t");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		const lines = editor.render(80).map(stripTerminalSequences);
		expect(lines[2]).toMatch(/^─+$/);
		expect(lines.slice(3).join("\n")).toContain("/help");
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput("\r");
		editor.handleInput("\r");
		expect(submit).toHaveBeenCalledWith("/help");
	});

	it("follow-up 快捷键绕过 Enter 时仍记录输入", () => {
		const record = vi.fn();
		const editor = createEditor({ record });
		editor.onAction("app.message.followUp", () => {
			editor.addToHistory(editor.getExpandedText());
			editor.setText("");
		});
		editor.setText("queued follow-up");
		editor.handleInput(useWindowsKeybindings() ? "\x11" : "\x1b\r");
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith("queued follow-up");
	});
});

function createEditor(options: Partial<ConstructorParameters<typeof SessionEditor>[3]> = {}, mode: TuiMode = "regular"): SessionEditor {
	const terminal = new ProcessTerminal();
	const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const identity = (text: string): string => text;
	const theme: EditorTheme = {
		borderColor: identity,
		selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
	};
	return new SessionEditor(tui, theme, KeybindingsManager.create(temp.path), {
		initialHistory: [], replayHistory: [], record() {}, getSnapshot: tuiSnapshot, getTheme: plainTheme, ...options,
	});
}
