import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { act, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import { SettingsStateContext, useSettingsCoordinator } from "../../src/gui/frontend/forms/drafts.tsx";
import { SettingsActions } from "../../src/gui/frontend/forms/settings-controls.tsx";
import { McpSettings } from "../../src/gui/frontend/features/mcp/mcp-settings.tsx";
import { ModuleSettings } from "../../src/gui/frontend/features/modules/module-settings.tsx";
import type { GuiSettings } from "../../src/gui/frontend/features/preferences/gui-settings.tsx";
import { readGuiDefaults } from "../../src/gui/host/config/preferences.ts";
import { editPreference, type ReadyGuiConfig } from "../../src/gui/frontend/features/preferences/gui-settings-draft.ts";
import type { GlobalQuery, Query } from "../../src/gui/shared/protocol/queries.ts";
import type { Send } from "../../src/gui/frontend/connection/connection.ts";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
const autoTitleDefaults = readFileSync(new URL("../../agent/defaults/auto-title.jsonc", import.meta.url), "utf8");
let Preferences: typeof GuiSettings;
beforeEach(async () => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("MutationObserver", window.MutationObserver);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
	Preferences = (await import("../../src/gui/frontend/features/preferences/gui-settings.tsx")).GuiSettings;
});
const onDirty = vi.fn();
function View({ children }: { children: ReactNode }) {
	const state = useSettingsCoordinator(onDirty);
	return <TooltipProvider><SettingsStateContext value={state}>{children}
		<SettingsActions count={state.dirtyPages.size} saving={state.saving} blocked={state.blocked} disabled={false}
			error={state.error} status={state.status} save={state.save} discard={state.discard} />
	</SettingsStateContext></TooltipProvider>;
}
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text);
async function click(element: HTMLButtonElement | undefined | null) {
	expect(element).toBeTruthy();
	await act(async () => element?.click());
}
function expectDirty(dirty: boolean) {
	for (const label of ["保存", "放弃"]) expect(named(label)?.disabled, label).toBe(!dirty);
	expect(onDirty).toHaveBeenLastCalledWith(dirty);
}

it("模块开关改回初始值后无需保存，默认值隐藏重置", async () => {
	const content = "{}";
	const query = vi.fn<Query<GlobalQuery>>().mockResolvedValue({ path: "auto-title.jsonc", content,
		defaults: autoTitleDefaults, options: {}, arrayOptions: {}, fields: {} });
	const send = vi.fn<Send>().mockResolvedValue(true);
	await render(<View><ModuleSettings id="autoTitle" title="自动标题" query={query} send={send} disabled={false} models={[]} tools={null} /></View>);
	expectDirty(false);
	expect(button("重置自动生成标题")).toBeNull();
	await click(button("自动生成标题"));
	expectDirty(true);
	expect(button("重置自动生成标题")).not.toBeNull();
	await click(button("自动生成标题"));
	expectDirty(false);
	expect(send).not.toHaveBeenCalled();
	await click(named("JSONC"));
	expect(document.querySelector<HTMLTextAreaElement>("textarea")?.defaultValue).toBe(content);
});

it("模块保存失败保留草稿，放弃恢复原值，保存成功采用新基准", async () => {
	const content = '{"enabled":true}';
	const query = vi.fn<Query<GlobalQuery>>().mockResolvedValue({ path: "auto-title.jsonc", content,
		defaults: autoTitleDefaults, options: {}, arrayOptions: {}, fields: {} });
	const send = vi.fn<Send>().mockResolvedValueOnce(false).mockResolvedValue(true);
	await render(<View><ModuleSettings id="autoTitle" title="自动标题" query={query} send={send} disabled={false} models={[]} tools={null} /></View>);
	await click(button("重置自动生成标题"));
	expectDirty(true);
	expect(button("重置自动生成标题")).toBeNull();
	await click(named("保存"));
	expectDirty(true);
	expect(button("自动生成标题")?.getAttribute("aria-checked")).toBe("false");
	await click(named("放弃"));
	expectDirty(false);
	expect(button("自动生成标题")?.getAttribute("aria-checked")).toBe("true");
	await click(button("重置自动生成标题"));
	await click(named("保存"));
	const action = send.mock.calls[1]?.[0];
	if (action?.action !== "saveModuleConfig") throw new Error("未保存模块配置");
	expect(action.original).toBe(content);
	expect(parse(action.content)).toEqual({});
	expectDirty(false);
	await click(button("自动生成标题"));
	expectDirty(true);
	await click(button("自动生成标题"));
	expectDirty(false);
});

it.each([undefined, true])("MCP 开关 %s 跨表单和源码切换后改回初始值无需保存", async (enabled) => {
	const content = JSON.stringify({ mcpServers: { one: { command: "node", enabled } } });
	const query = vi.fn<Query<GlobalQuery>>().mockResolvedValue({ path: "mcp.json", content });
	await render(<View><McpSettings query={query} send={vi.fn()} disabled={false} /></View>);
	expectDirty(false);
	await click(button("one"));
	expectDirty(true);
	await click(named("JSON"));
	await click(named("表单"));
	await click(button("one"));
	expectDirty(false);
	await click(named("JSON"));
	expect(document.querySelector<HTMLTextAreaElement>("textarea")?.defaultValue).toBe(content);
});

it("MCP 保存失败保留草稿，放弃和保存保持行节点与正确基准", async () => {
	const content = '{ "mcpServers": { "one": { "command": "node", "enabled": false, "extra": {} } } }';
	const query = vi.fn<Query<GlobalQuery>>().mockResolvedValue({ path: "mcp.json", content });
	const send = vi.fn<Send>().mockResolvedValueOnce(false).mockResolvedValue(true);
	await render(<View><McpSettings query={query} send={send} disabled={false} /></View>);
	const toggle = button("one");
	await click(toggle);
	await click(named("保存"));
	expectDirty(true);
	expect(toggle?.getAttribute("aria-checked")).toBe("true");
	await click(named("放弃"));
	expectDirty(false);
	expect(button("one")).toBe(toggle);
	expect(toggle?.getAttribute("aria-checked")).toBe("false");
	await click(toggle);
	await click(named("保存"));
	expectDirty(false);
	expect(button("one")).toBe(toggle);
	const action = send.mock.calls[1]?.[0];
	if (action?.action !== "saveMcpConfig") throw new Error("未保存 MCP 配置");
	expect(action.original).toBe(content);
	expect(JSON.parse(action.content)).toEqual({ mcpServers: { one: { command: "node", extra: {} } } });
	await click(toggle);
	expectDirty(true);
	await click(toggle);
	expectDirty(false);
});

it.each([
	["appearance", "磨砂材质", "重置外观"],
	["interaction", "执行任务时防止空闲睡眠", "重置对话交互"],
	["desktopWeb", "Web 访问", "重置桌面 Web 访问"],
] as const)("GUI %s 改回初始值后禁用保存，分组重置仅在非默认时显示", async (section, label, reset) => {
	const defaults = readGuiDefaults();
	const document: ReadyGuiConfig = { state: "ready", path: "gui.jsonc", content: "{}\n", value: defaults, defaults };
	const title = reset.slice(2);
	await render(<View><Preferences title={title} section={section} document={document} send={vi.fn()} query={vi.fn()}
		disabled={false} refresh={vi.fn()} restoreFocus={vi.fn()} /></View>);
	expectDirty(false);
	expect(button(reset)).toBeNull();
	await click(button(label));
	expectDirty(true);
	expect(button(reset)).not.toBeNull();
	await click(button(label));
	expectDirty(false);
	expect(button(reset)).toBeNull();
	expect(button(`重置${label}`)).toBeNull();
});

it("恢复默认不同于初始值时仍需保存，另一项的修改不会被清除", async () => {
	const defaults = readGuiDefaults();
	const base: ReadyGuiConfig = { state: "ready", path: "gui.jsonc", content: "{}", value: defaults, defaults };
	const document = editPreference(base, ["preventSleepWhileRunning"], !defaults.preventSleepWhileRunning);
	await render(<View><Preferences title="对话交互" section="interaction" document={document} send={vi.fn()} query={vi.fn()}
		disabled={false} refresh={vi.fn()} restoreFocus={vi.fn()} /></View>);
	await click(button("执行任务时防止空闲睡眠"));
	expectDirty(true);
	expect(button("重置执行任务时防止空闲睡眠")).toBeNull();
	expect(button("重置对话交互")).toBeNull();
	await click(button("使用外部应用打开文件链接"));
	await click(button("执行任务时防止空闲睡眠"));
	expectDirty(true);
	await click(button("使用外部应用打开文件链接"));
	expectDirty(false);
});

it("材质区域默认值不显示重置按钮", async () => {
	const defaults = readGuiDefaults();
	const base: ReadyGuiConfig = { state: "ready", path: "gui.jsonc", content: "{}", value: defaults, defaults };
	await render(<View><Preferences title="外观" section="appearance" document={base} send={vi.fn()} query={vi.fn()}
		disabled={false} refresh={vi.fn()} restoreFocus={vi.fn()} /></View>);
	await click(named("分区域调整"));
	expect(button("重置内容画布材质")).toBeNull();
});
