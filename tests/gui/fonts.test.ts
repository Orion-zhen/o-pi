import { expect, it } from "vitest";
import { fontFamily } from "../../src/gui/ui/use-preferences.ts";

it("保留用户字体顺序并追加对应的系统回退", () => {
	expect(fontFamily(["Inter", "Noto Sans SC", "Apple Color Emoji"], "ui"))
		.toBe('"Inter", "Noto Sans SC", "Apple Color Emoji", system-ui, sans-serif');
	expect(fontFamily(["JetBrains Mono", "Noto Sans Mono CJK SC"], "code"))
		.toBe('"JetBrains Mono", "Noto Sans Mono CJK SC", ui-monospace, monospace');
	expect(fontFamily([], "ui")).toBe("system-ui, sans-serif");
	expect(fontFamily([], "code")).toBe("ui-monospace, monospace");
});

it("手写通用字体族作为关键字，普通名称始终作为单个字体族", () => {
	expect(fontFamily(["Georgia", "SERIF"], "ui")).toBe('"Georgia", serif, system-ui, sans-serif');
	expect(fontFamily(["inherit", "Font, Name"], "ui")).toBe('"inherit", "Font, Name", system-ui, sans-serif');
	expect(fontFamily(['My "Font" \\ Name'], "code")).toBe('"My \\22 Font\\22  \\5c  Name", ui-monospace, monospace');
});
