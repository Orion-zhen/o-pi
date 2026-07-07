import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultLspConfig, loadLspConfig, normalizeExcludePath } from "../../src/lsp/config.js";

let dir: string;
let previousConfig: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-lsp-config-"));
	previousConfig = process.env.PI_LSP_CONFIG;
});

afterEach(async () => {
	if (previousConfig === undefined) delete process.env.PI_LSP_CONFIG;
	else process.env.PI_LSP_CONFIG = previousConfig;
	await rm(dir, { recursive: true, force: true });
});

describe("lsp config", () => {
	it("缺少配置文件采用默认值", async () => {
		process.env.PI_LSP_CONFIG = path.join(dir, "missing.jsonc");
		expect(await loadLspConfig()).toEqual({ path: path.join(dir, "missing.jsonc"), config: defaultLspConfig() });
	});

	it("支持 JSONC、trailing comma 和部分覆盖", async () => {
		const file = path.join(dir, "lsp.jsonc");
		await writeFile(
			file,
			`{
				"$schema": "../schemas/lsp.schema.json",
				"version": 1,
				"exclude_paths": ["~"],
				"request_timeout_ms": 700,
				"diagnostics": { "max_items": 3, "min_severity": "error", },
				"servers": [
					{ "id": "demo", "command": "demo-lsp", "args": ["--stdio"], "extensions": [".demo"], },
				],
			}`,
		);
		process.env.PI_LSP_CONFIG = file;
		expect(await loadLspConfig()).toMatchObject({
			path: file,
			config: {
				request_timeout_ms: 700,
				exclude_paths: [os.homedir()],
				diagnostics: { max_items: 3, min_severity: "error" },
				servers: [{ id: "demo", enabled: true, command: "demo-lsp", args: ["--stdio"], extensions: [".demo"] }],
			},
		});
	});

	it("拒绝 schema 错误", async () => {
		const file = path.join(dir, "bad.jsonc");
		process.env.PI_LSP_CONFIG = file;
		await writeFile(file, '{ "version": 1, "unknown": true }');
		await expect(loadLspConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "version": 1, "diagnostics": { "min_severity": "fatal" } }');
		await expect(loadLspConfig()).rejects.toThrow("does not match schema");
	});

	it("环境变量覆盖配置路径", async () => {
		const file = path.join(dir, "override.jsonc");
		await writeFile(file, '{ "version": 1, "enabled": false }');
		process.env.PI_LSP_CONFIG = file;
		expect(await loadLspConfig()).toMatchObject({ path: file, config: { enabled: false } });
	});

	it("规范化 exclude_paths 中的用户家目录", () => {
		expect(normalizeExcludePath("~")).toBe(path.resolve(os.homedir()));
		expect(normalizeExcludePath("~/demo")).toBe(path.join(os.homedir(), "demo"));
	});
});
