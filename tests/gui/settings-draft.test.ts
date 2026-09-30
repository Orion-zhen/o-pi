import { expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";
import { editPreference, resetSection, sectionSave, type ReadyGuiConfig } from "../../src/gui/ui/gui-settings-draft.ts";

function initial(): ReadyGuiConfig {
	const defaults = readGuiDefaults();
	return { state: "ready", path: "gui.jsonc", content: "", defaults, value: defaults };
}

it("表单修改只更新草稿，嵌套字段保留默认值", () => {
	const base = initial();
	const draft = editPreference(base, ["fontSizes", "chat"], 20);
	expect(base.content).toBe("");
	expect(draft.value.fontSizes).toEqual({ ...base.defaults.fontSizes, chat: 20 });
	expect(parse(draft.content)).toEqual({ fontSizes: { chat: 20 } });
	expect(editPreference(draft, ["fontSizes", "chat"], undefined).value.fontSizes).toEqual(base.defaults.fontSizes);
});

it("不同页面的草稿分别保存，不覆盖已经保存的其它页面", () => {
	const base = initial();
	const appearance = editPreference(base, ["theme"], "dark");
	const interaction = editPreference(base, ["sendShortcut"], "enter");
	const saved = sectionSave(base, appearance, interaction, "appearance");
	expect(saved.original).toBe(interaction.content);
	expect(parse(saved.content)).toEqual({ theme: "dark", sendShortcut: "enter" });
});

it("同页外部修改保留原始版本用于保存冲突检查", () => {
	const base = initial();
	const draft = editPreference(base, ["theme"], "dark");
	const external = editPreference(base, ["theme"], "light");
	expect(sectionSave(base, draft, external, "appearance").original).toBe(base.content);
});

it("恢复默认值只重置本页，不修改其它设置或缓存策略", () => {
	let base = editPreference(initial(), ["theme"], "dark");
	base = editPreference(base, ["desktopWeb", "enabled"], true);
	base = editPreference(base, ["sessionCache", "idleLimit"], 8);
	const draft = resetSection(base, "appearance");
	expect(draft.value.theme).toBe(base.defaults.theme);
	expect(draft.value.desktopWeb.enabled).toBe(true);
	expect(draft.value.sessionCache).toEqual({ ...base.defaults.sessionCache, idleLimit: 8 });
	expect(parse(draft.content)).toEqual({ desktopWeb: { enabled: true }, sessionCache: { idleLimit: 8 } });
});
