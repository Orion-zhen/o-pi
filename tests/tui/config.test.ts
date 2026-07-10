import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultTuiConfig, loadTuiConfig, TuiConfigError } from "../../src/tui/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-tui-config-");
preserveEnv("PI_TUI_CONFIG");

beforeEach(() => {
	dir = temp.path;
});

describe("tui config", () => {
	it("缺失配置使用默认值", async () => {
		process.env["PI_TUI_CONFIG"] = path.join(dir, "missing.jsonc");
		await expect(loadTuiConfig()).resolves.toEqual(defaultTuiConfig());
	});

	it("加载 jsonc 覆盖并合并默认值", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(
			file,
			'{ "version": 1, "icons": "ascii", "chrome": { "footer": false }, "footer": { "style": { "workspace_color": "warning", "git_color": "accent", "git_icon": "" } }, "banner": { "layout": "stacked", "style": "compact", "side_by_side_min_width": 120, "tiny_width": 36, "show_hints": false } }',
		);
		process.env["PI_TUI_CONFIG"] = file;
		const config = await loadTuiConfig();
		expect(config.icons).toBe("ascii");
		expect(config.chrome.footer).toBe(false);
		expect(config.footer.style.workspace_color).toBe("warning");
		expect(config.footer.style.git_color).toBe("accent");
		expect(config.footer.style.git_icon).toBe("");
		expect(config.footer.max_lines).toBe(2);
		expect(config.tools.collapsed_lines).toBe(2);
		expect(config.banner.layout).toBe("stacked");
		expect(config.banner.style).toBe("compact");
		expect(config.banner.side_by_side_min_width).toBe(120);
		expect(config.banner.tiny_width).toBe(36);
		expect(config.banner.show_hints).toBe(false);
		expect(config.banner.show_capabilities).toBe(true);
		expect(config.math).toEqual(defaultTuiConfig().math);
	});

	it("缺失 banner 时合并默认值", async () => {
		const file = path.join(dir, "no-banner.jsonc");
		await writeFile(file, '{ "version": 1, "chrome": { "header": true } }');
		process.env["PI_TUI_CONFIG"] = file;
		const config = await loadTuiConfig();
		expect(config.banner).toEqual(defaultTuiConfig().banner);
		expect(config.chrome.header).toBe(true);
	});

	it("加载 math 配置覆盖并合并默认值", async () => {
		const file = path.join(dir, "math.jsonc");
		await writeFile(file, '{ "version": 1, "math": { "inline": "source", "svg_scale": 4, "foreground": "#ffffff" } }');
		process.env["PI_TUI_CONFIG"] = file;
		const config = await loadTuiConfig();
		expect(config.math.enabled).toBe(true);
		expect(config.math.display).toBe(true);
		expect(config.math.inline).toBe("source");
		expect(config.math.svg_scale).toBe(4);
		expect(config.math.foreground).toBe("#ffffff");
	});

	it("schema 校验失败给出错误", async () => {
		const file = path.join(dir, "bad.jsonc");
		await writeFile(file, '{ "version": 2 }');
		process.env["PI_TUI_CONFIG"] = file;
		await expect(loadTuiConfig()).rejects.toBeInstanceOf(TuiConfigError);
	});

	it("collapsed_lines 只能是 2", async () => {
		const file = path.join(dir, "bad-lines.jsonc");
		await writeFile(file, '{ "version": 1, "tools": { "collapsed_lines": 3 } }');
		process.env["PI_TUI_CONFIG"] = file;
		await expect(loadTuiConfig()).rejects.toBeInstanceOf(TuiConfigError);
	});

	it("非法 banner layout/style/width 被 schema 拒绝", async () => {
		for (const [name, text] of [
			["layout", '{ "version": 1, "banner": { "layout": "wide" } }'],
			["style", '{ "version": 1, "banner": { "style": "full" } }'],
			["side", '{ "version": 1, "banner": { "side_by_side_min_width": 40 } }'],
			["tiny", '{ "version": 1, "banner": { "tiny_width": 12 } }'],
			["math-inline", '{ "version": 1, "math": { "inline": "image" } }'],
			["math-color", '{ "version": 1, "math": { "foreground": "white" } }'],
		] as const) {
			const file = path.join(dir, `${name}.jsonc`);
			await writeFile(file, text);
			process.env["PI_TUI_CONFIG"] = file;
			await expect(loadTuiConfig()).rejects.toBeInstanceOf(TuiConfigError);
		}
	});

	it("defaultTuiConfig 返回深拷贝", () => {
		const first = defaultTuiConfig();
		first.footer.segments.push("status");
		first.banner.enabled = false;
		const second = defaultTuiConfig();
		expect(second.footer.segments).toEqual(["cwd", "git", "model", "ctx", "tokens", "cost", "status"]);
		expect(second.banner.enabled).toBe(true);
	});
});
