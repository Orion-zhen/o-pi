import { expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { readGuiDefaults } from "../../../../../src/gui/host/config/preferences.ts";
import { editPreference, resetSection, sectionChanged, preferenceSave, readPreferenceSource, type ReadyGuiConfig } from "../../../../../src/gui/frontend/features/preferences/gui-settings-draft.ts";

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
	expect(sectionChanged(base.value, draft.value, "appearance")).toBe(true);
	expect(sectionChanged(base.value, draft.value, "interaction")).toBe(false);
	const restored = editPreference(draft, ["fontSizes", "chat"], undefined);
	expect(restored.value.fontSizes).toEqual(base.defaults.fontSizes);
	expect(sectionChanged(base.value, restored.value, "appearance")).toBe(false);
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
	expect(parse(preferenceSave(base, draft, base).content)).toMatchObject({ materials: { canvas: { opacity: 82 }, sidebar: { opacity: 55 }, floating: { blur: 0 } }, sendShortcut: "enter" });
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

it("一次保存多个已编辑分区，保留未编辑分区的外部修改", () => {
	const base = initial();
	const draft = editPreference(editPreference(base, ["theme"], "dark"), ["sendShortcut"], "enter");
	const external = editPreference(base, ["desktopWeb", "port"], 9000);
	const saved = preferenceSave(base, draft, external);
	expect(saved.original).toBe(external.content);
	expect(parse(saved.content)).toEqual({ theme: "dark", sendShortcut: "enter", desktopWeb: { port: 9000 } });
});

it("编辑期间外部文件损坏，保存保留原始版本供冲突检查", () => {
	const base = initial();
	const draft = editPreference(base, ["theme"], "dark");
	const external = readPreferenceSource(base, '{"theme":');
	expect(preferenceSave(base, draft, external)).toEqual({ original: base.content, content: draft.content });
});

it("同页外部修改保留原始版本用于保存冲突检查", () => {
	const base = initial();
	const draft = editPreference(base, ["theme"], "dark");
	const external = editPreference(base, ["theme"], "light");
	expect(preferenceSave(base, draft, external).original).toBe(base.content);
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
