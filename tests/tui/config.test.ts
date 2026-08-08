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
		process.env.PI_TUI_CONFIG = path.join(dir, "missing.jsonc");
		await expect(loadTuiConfig()).resolves.toEqual(defaultTuiConfig());
	});

	it("加载 JSONC 覆盖并保留未配置的默认分组", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, `{
			"icons": "ascii",
			"chrome": { "footer": false },
			"banner": { "layout": "stacked", "show_hints": false },
			"math": { "max_height_cells": 24, "svg_scale": 4 }
		}`);
		process.env.PI_TUI_CONFIG = file;

		await expect(loadTuiConfig()).resolves.toMatchObject({
			icons: "ascii",
			chrome: { footer: false },
			banner: { layout: "stacked", show_hints: false },
			math: { max_height_cells: 24, svg_scale: 4 },
			tools: defaultTuiConfig().tools,
		});
	});

	it.each([
		'{ "unknown": true }',
		'{ "tools": { "collapsed_lines": 3 } }',
		'{ "banner": { "layout": "wide" } }',
		'{ "math": { "inline": "source" } }',
	])("拒绝不符合 schema 的配置 %#", async (text) => {
		const file = path.join(dir, "bad.jsonc");
		await writeFile(file, text);
		process.env.PI_TUI_CONFIG = file;
		await expect(loadTuiConfig()).rejects.toBeInstanceOf(TuiConfigError);
	});
});
