import { readFileSync } from "node:fs";
import { act, type ComponentProps, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { McpSettings } from "../../src/gui/frontend/features/mcp/mcp-settings.tsx";
import { ModuleSettings } from "../../src/gui/frontend/features/modules/module-settings.tsx";
import { ModelServicesSettings } from "../../src/gui/frontend/features/models/services/model-services-settings.tsx";
import { modelsConfigSchema } from "../../src/harness/openai-compatible-provider/config.ts";
import type { SourceEditor } from "../../src/gui/frontend/forms/source-editor.tsx";
import { SettingsStateContext, useSettingsCoordinator } from "../../src/gui/frontend/forms/drafts.tsx";
import { SettingsActions } from "../../src/gui/frontend/forms/settings-controls.tsx";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import type { Send } from "../../src/gui/frontend/connection/connection.ts";
import { useReactFixture } from "./react-fixture.ts";

vi.mock("../../src/gui/frontend/forms/source-editor.tsx", () => ({
	SourceEditor: ({ label, value, disabled, onChange }: ComponentProps<typeof SourceEditor>) =>
		<textarea aria-label={label} value={value} disabled={disabled} onInput={(event) => onChange(event.currentTarget.value)} />,
}));
const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const defaults = readFileSync(new URL("../../agent/defaults/auto-title.jsonc", import.meta.url), "utf8");
function View({ children }: { children: ReactNode }) {
	const state = useSettingsCoordinator(vi.fn());
	return <TooltipProvider><SettingsStateContext value={state}>{children}
		<SettingsActions count={state.dirtyPages.size} saving={state.saving} blocked={state.blocked} disabled={false}
			error={state.error} status={state.status} save={state.save} discard={state.discard} />
	</SettingsStateContext></TooltipProvider>;
}
const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text);
const source = () => document.querySelector<HTMLTextAreaElement>("textarea");
async function click(text: string) {
	const button = named(text);
	expect(button).toBeTruthy();
	await act(async () => button?.click());
}
async function input(content: string) {
	const element = source();
	if (!element) throw new Error("缺少源码编辑器");
	await act(async () => { element.value = content; element.dispatchEvent(new window.Event("input", { bubbles: true })); });
}

it.each([
	["module", "JSONC", "{}\n", "saveModuleConfig"],
	["mcp", "JSON", '{"mcpServers":{"one":{"command":"node","enabled":false}}}', "saveMcpConfig"],
	["models", "JSON", '{"providers":{"local":{"api":"openai-completions"}}}', "saveModelServices"],
] as const)("%s 源码跨视图、保存与放弃保留精确原文", async (kind, sourceButton, original, action) => {
	const send = vi.fn<Send>().mockResolvedValue(true);
	const props = { send, disabled: false };
	const component = kind === "module" ? <ModuleSettings {...props} id="autoTitle" title="自动标题" models={[]} tools={null} currentModel={null}
		query={vi.fn().mockResolvedValue({ path: "auto-title.jsonc", content: original, defaults, options: {}, arrayOptions: {}, fields: {} })} />
		: kind === "mcp" ? <McpSettings {...props} query={vi.fn().mockResolvedValue({ path: "mcp.json", content: original })} />
		: <ModelServicesSettings {...props} sessionId={undefined} sessionRevision={undefined} sessionReady={false} query={vi.fn()} globalQuery={vi.fn().mockResolvedValue({ path: "models.json", content: original, schema: modelsConfigSchema })} />;
	await render(<View>{component}</View>);
	await click(sourceButton);
	expect(source()?.defaultValue).toBe(original);
	const content = `\n${original}\n`;
	await input(content);
	await click("表单");
	await click(sourceButton);
	expect(source()?.defaultValue).toBe(content);
	await input(original);
	expect(named("保存")?.disabled).toBe(true);
	await input(content);
	await click("保存");
	expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action, original, content }));
	expect(named("保存")?.disabled).toBe(true);
	await input(original);
	expect(named("保存")?.disabled).toBe(false);
	await click("放弃");
	expect(source()?.defaultValue).toBe(content);
	expect(named("保存")?.disabled).toBe(true);
	await click("表单");
	await click(sourceButton);
	expect(source()?.defaultValue).toBe(content);
});
