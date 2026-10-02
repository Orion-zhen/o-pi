import { expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";
import { editPreference, resetSection, sectionSave, type ReadyGuiConfig } from "../../src/gui/ui/settings/gui-settings-draft.ts";

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

it("材质草稿保留同一区域默认字段，恢复默认只清除外观覆盖", () => {
	const base = editPreference(initial(), ["sendShortcut"], "enter");
	const canvas = editPreference(base, ["materials", "canvas", "opacity"], 82);
	const draft = editPreference(editPreference(canvas, ["materials", "sidebar", "opacity"], 55), ["materials", "floating", "blur"], 0);
	expect(draft.value.materials.canvas).toEqual({ ...base.defaults.materials.canvas, opacity: 82 });
	expect(draft.value.materials.sidebar).toEqual({ ...base.defaults.materials.sidebar, opacity: 55 });
	expect(draft.value.materials.floating).toEqual({ ...base.defaults.materials.floating, blur: 0 });
	expect(draft.value.materials.dialog).toEqual(base.defaults.materials.dialog);
	const reset = editPreference(draft, ["materials", "sidebar", "opacity"], undefined);
	expect(reset.value.materials.sidebar).toEqual(base.defaults.materials.sidebar);
	expect(reset.value.materials.floating.blur).toBe(0);
	expect(parse(sectionSave(base, draft, base, "appearance").content)).toMatchObject({ materials: { canvas: { opacity: 82 }, sidebar: { opacity: 55 }, floating: { blur: 0 } }, sendShortcut: "enter" });
	expect(resetSection(draft, "appearance").value.materials).toEqual(base.defaults.materials);
	expect(parse(resetSection(draft, "appearance").content)).toEqual({ sendShortcut: "enter" });
});

it("深浅色不透明度独立修改和重置，不相互覆盖", () => {
	const base = initial();
	const light = editPreference(base, ["materials", "canvas", "opacity"], 80);
	const dark = editPreference(light, ["materials", "canvas", "darkOpacity"], 98);
	expect(dark.value.materials.canvas).toEqual({ ...base.defaults.materials.canvas, opacity: 80, darkOpacity: 98 });
	expect(parse(dark.content)).toEqual({ materials: { canvas: { opacity: 80, darkOpacity: 98 } } });
	const reset = editPreference(dark, ["materials", "canvas", "darkOpacity"], undefined);
	expect(reset.value.materials.canvas).toEqual({ ...base.defaults.materials.canvas, opacity: 80 });
	expect(parse(reset.content)).toEqual({ materials: { canvas: { opacity: 80 } } });
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
