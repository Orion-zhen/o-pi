import { act, type ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSettings } from "../../../../../src/gui/frontend/features/sessions/settings.tsx";
import type { SourceEditor } from "../../../../../src/gui/frontend/forms/source-editor.tsx";
import { SettingsStateContext, useSettingsCoordinator } from "../../../../../src/gui/frontend/forms/drafts.tsx";
import { SettingsActions } from "../../../../../src/gui/frontend/forms/settings-controls.tsx";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import type { Send } from "../../../../../src/gui/frontend/connection/connection.ts";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

vi.mock("../../../../../src/gui/frontend/forms/source-editor.tsx", () => ({
	SourceEditor: ({ label, value, disabled, onChange }: ComponentProps<typeof SourceEditor>) =>
		<textarea aria-label={label} value={value} disabled={disabled} onInput={(event) => onChange(event.currentTarget.value)} />,
}));
const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("MutationObserver", window.MutationObserver);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const settings: ComponentProps<typeof AgentSettings>["settings"] = {
	compaction: true, retry: true, steering: "one-at-a-time", followUp: "one-at-a-time", autoResize: true, blockImages: false,
};
const onDirty = vi.fn();
function View({ send, query, current = settings }: Pick<ComponentProps<typeof AgentSettings>, "send" | "query"> & { current?: typeof settings }) {
	const state = useSettingsCoordinator(onDirty);
	return <TooltipProvider><SettingsStateContext value={state}>
		<AgentSettings settings={current} send={send} query={query} disabled={false} />
		<SettingsActions count={state.dirtyPages.size} saving={state.saving} blocked={state.blocked} disabled={false}
			error={state.error} status={state.status} save={state.save} discard={state.discard} />
	</SettingsStateContext></TooltipProvider>;
}
const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text);
const toggle = () => document.querySelector<HTMLButtonElement>('button[aria-label="自动缩放图片"]');
const source = () => document.querySelector<HTMLTextAreaElement>("textarea");
async function click(element: HTMLButtonElement | null | undefined) {
	expect(element).toBeTruthy();
	await act(async () => element?.click());
}
async function input(content: string) {
	const element = source();
	if (!element) throw new Error("缺少源码编辑器");
	await act(async () => { element.value = content; element.dispatchEvent(new window.Event("input", { bubbles: true })); });
}

it("表单草稿阻止打开源码，改回原值取消修改，保存使用会话设置操作", async () => {
	const send = vi.fn<Send>().mockResolvedValue(true);
	const query = vi.fn();
	await render(<View send={send} query={query} />);
	await click(toggle());
	expect(named("JSON")?.disabled).toBe(true);
	await click(toggle());
	expect(named("保存")?.disabled).toBe(true);
	expect(named("JSON")?.disabled).toBe(false);
	await click(toggle());
	await click(named("保存"));
	expect(send).toHaveBeenCalledExactlyOnceWith({ action: "settings", ...settings, autoResize: false });
	expect(query).not.toHaveBeenCalled();
});

it("表单改回原值后跟随最新会话设置，不留下旧草稿", async () => {
	const props = { send: vi.fn(), query: vi.fn() };
	await render(<View {...props} />);
	await click(toggle());
	await click(toggle());
	await render(<View {...props} current={{ ...settings, autoResize: false }} />);
	expect(toggle()?.getAttribute("aria-checked")).toBe("false");
	expect(named("保存")?.disabled).toBe(true);
});

it("无修改的源码退出后重新读取文件，不复用旧缓存", async () => {
	const query = vi.fn().mockResolvedValueOnce("{}\n").mockResolvedValueOnce('{"images":{"autoResize":false}}\n');
	await render(<View send={vi.fn()} query={query} />);
	await click(named("JSON"));
	expect(source()?.defaultValue).toBe("{}\n");
	await click(named("表单"));
	await click(named("JSON"));
	expect(query).toHaveBeenCalledTimes(2);
	expect(source()?.defaultValue).toBe('{"images":{"autoResize":false}}\n');
	expect(named("保存")?.disabled).toBe(true);
});

it("源码跨视图保留草稿，失败不清空，保存和放弃使用精确文本基准", async () => {
	const original = "{}\n";
	const content = '\n{ "images": { "autoResize": false } }\n';
	const query = vi.fn().mockResolvedValue(original);
	const send = vi.fn<Send>().mockResolvedValueOnce(false).mockResolvedValue(true);
	await render(<View send={send} query={query} />);
	await click(named("JSON"));
	await input(content);
	await click(named("表单"));
	expect(toggle()?.disabled).toBe(true);
	expect(onDirty).toHaveBeenLastCalledWith(true);
	await click(named("JSON"));
	expect(query).toHaveBeenCalledTimes(1);
	expect(source()?.defaultValue).toBe(content);
	await click(named("保存"));
	expect(source()?.defaultValue).toBe(content);
	expect(named("保存")?.disabled).toBe(false);
	await click(named("保存"));
	expect(send).toHaveBeenLastCalledWith({ action: "saveConfig", file: "settings.json", original, content });
	expect(named("保存")?.disabled).toBe(true);
	await input(original);
	await click(named("放弃"));
	expect(source()?.defaultValue).toBe(content);
	expect(named("保存")?.disabled).toBe(true);
	await input(`\n${content}`);
	await click(named("保存"));
	expect(send).toHaveBeenLastCalledWith({ action: "saveConfig", file: "settings.json", original: content, content: `\n${content}` });
});

it("源码语法错误阻止保存和返回表单，放弃恢复原文", async () => {
	await render(<View send={vi.fn()} query={vi.fn().mockResolvedValue("{}\n")} />);
	await click(named("JSON"));
	await input('{"images":');
	expect(named("保存")?.disabled).toBe(true);
	expect(named("表单")?.disabled).toBe(true);
	expect(document.querySelector('[role="alert"]')).not.toBeNull();
	await click(named("放弃"));
	expect(source()?.defaultValue).toBe("{}\n");
	expect(named("表单")?.disabled).toBe(false);
	expect(onDirty).toHaveBeenLastCalledWith(false);
});

it("源码草稿在表单视图放弃后解除表单锁定", async () => {
	await render(<View send={vi.fn()} query={vi.fn().mockResolvedValue("{}")} />);
	await click(named("JSON"));
	await input("\n{}\n");
	await click(named("表单"));
	expect(toggle()?.disabled).toBe(true);
	await click(named("放弃"));
	expect(toggle()?.disabled).toBe(false);
	await click(toggle());
	expect(named("保存")?.disabled).toBe(false);
});

it("源码读取期间禁用编辑，读取失败后允许重试", async () => {
	const pending = Promise.withResolvers<string>();
	const query = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue("{}");
	await render(<View send={vi.fn()} query={query} />);
	await click(named("JSON"));
	expect(toggle()?.disabled).toBe(true);
	expect(named("JSON")?.disabled).toBe(true);
	await act(async () => { pending.reject(new Error("读取失败")); });
	expect(toggle()?.disabled).toBe(false);
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("读取失败");
	await click(named("JSON"));
	expect(source()?.defaultValue).toBe("{}");
});
