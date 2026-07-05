import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultTuiConfig, loadTuiConfig, TuiConfigError } from "../../src/tui/config.js";

let dir: string;
let originalConfigPath: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-tui-config-"));
	originalConfigPath = process.env["PI_TUI_CONFIG"];
});

afterEach(async () => {
	if (originalConfigPath === undefined) delete process.env["PI_TUI_CONFIG"];
	else process.env["PI_TUI_CONFIG"] = originalConfigPath;
	await rm(dir, { recursive: true, force: true });
});

describe("tui config", () => {
	it("缺失配置使用默认值", async () => {
		process.env["PI_TUI_CONFIG"] = path.join(dir, "missing.jsonc");
		await expect(loadTuiConfig()).resolves.toEqual(defaultTuiConfig());
	});

	it("加载 jsonc 覆盖并合并默认值", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "version": 1, "icons": "ascii", "chrome": { "footer": false }, "footer": { "style": { "workspace_color": "warning", "git_color": "accent", "git_icon": "" } } }');
		process.env["PI_TUI_CONFIG"] = file;
		const config = await loadTuiConfig();
		expect(config.icons).toBe("ascii");
		expect(config.chrome.footer).toBe(false);
		expect(config.footer.style.workspace_color).toBe("warning");
		expect(config.footer.style.git_color).toBe("accent");
		expect(config.footer.style.git_icon).toBe("");
		expect(config.footer.max_lines).toBe(2);
		expect(config.tools.collapsed_lines).toBe(2);
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
});
