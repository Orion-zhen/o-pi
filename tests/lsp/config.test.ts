import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultLspConfig, loadLspConfig, normalizeExcludePath } from "../../src/lsp/config.js";
import { LspServerRegistry } from "../../src/lsp/registry.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-lsp-config-");
preserveEnv("PI_LSP_CONFIG");

beforeEach(() => {
	dir = temp.path;
});

describe("lsp config", () => {
	it("缺少配置文件采用默认值并为 JS/TS 变体配置 language IDs", async () => {
		process.env.PI_LSP_CONFIG = path.join(dir, "missing.jsonc");
		const loaded = await loadLspConfig();
		expect(loaded).toEqual({ path: path.join(dir, "missing.jsonc"), config: defaultLspConfig() });
		expect(loaded.config.max_open_documents).toBe(64);
		expect(loaded.config.servers[0]?.language_ids).toEqual({
			".ts": "typescript",
			".tsx": "typescriptreact",
			".js": "javascript",
			".jsx": "javascriptreact",
			".mjs": "javascript",
			".cjs": "javascript",
		});
	});

	it("支持 JSONC、trailing comma 和部分覆盖", async () => {
		const file = path.join(dir, "lsp.jsonc");
		await writeFile(
			file,
			`{
				"$schema": "../schemas/lsp.schema.json",
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
				servers: [{
					id: "demo",
					enabled: true,
					transport: { type: "stdio", command: "demo-lsp", args: ["--stdio"] },
					language_ids: {},
					extensions: [".demo"],
				}],
			},
		});
	});

	it("拒绝 schema 错误", async () => {
		const file = path.join(dir, "bad.jsonc");
		process.env.PI_LSP_CONFIG = file;
		await writeFile(file, '{ "unknown": true }');
		await expect(loadLspConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "diagnostics": { "min_severity": "fatal" } }');
		await expect(loadLspConfig()).rejects.toThrow("does not match schema");
	});

	it("规范化 server transport、language ID 和扩展名", async () => {
		const file = path.join(dir, "normalized.jsonc");
		await writeFile(file, JSON.stringify({
			servers: [{
				id: "demo",
				command: "demo-lsp",
				language_id: "demo-fallback",
				language_ids: { ".DEMO": "demo-special" },
				extensions: [".DEMO", ".demo"],
			}],
		}));
		process.env.PI_LSP_CONFIG = file;
		const loaded = await loadLspConfig();
		expect(loaded.config.servers).toEqual([{
			id: "demo",
			enabled: true,
			transport: { type: "stdio", command: "demo-lsp", args: [] },
			language_id: "demo-fallback",
			language_ids: { ".demo": "demo-special" },
			extensions: [".demo"],
		}]);
	});

	it.each([
		["重复 ID", [
			{ id: "demo", command: "one", extensions: [".one"] },
			{ id: "demo", command: "two", extensions: [".two"] },
		]],
		["大小写扩展名冲突", [
			{ id: "one", command: "one", extensions: [".Demo"] },
			{ id: "two", command: "two", extensions: [".demo"] },
		]],
		["disabled server 扩展名冲突", [
			{ id: "one", enabled: false, command: "one", extensions: [".demo"] },
			{ id: "two", command: "two", extensions: [".DEMO"] },
		]],
	])("拒绝%s", async (_label, servers) => {
		const file = path.join(dir, "conflict.jsonc");
		await writeFile(file, JSON.stringify({ servers }));
		process.env.PI_LSP_CONFIG = file;
		await expect(loadLspConfig()).rejects.toThrow(/LSP server ID|LSP extension/);
	});

	it("允许无冲突的 disabled 和 enabled server", async () => {
		const file = path.join(dir, "distinct.jsonc");
		await writeFile(file, JSON.stringify({ servers: [
			{ id: "disabled", enabled: false, command: "one", extensions: [".one"] },
			{ id: "enabled", command: "two", extensions: [".two"] },
		] }));
		process.env.PI_LSP_CONFIG = file;
		expect((await loadLspConfig()).config.servers.map((server) => server.id)).toEqual(["disabled", "enabled"]);
	});

	it("保留 TCP transport 并按规范化扩展名路由", async () => {
		const file = path.join(dir, "tcp.jsonc");
		await writeFile(file, JSON.stringify({
			servers: [{ id: "remote", transport: { type: "tcp", host: "127.0.0.1", port: 2087 }, extensions: [".REMOTE"] }],
		}));
		process.env.PI_LSP_CONFIG = file;
		const config = (await loadLspConfig()).config;
		expect(config.servers[0]).toMatchObject({
			transport: { type: "tcp", host: "127.0.0.1", port: 2087 },
			language_ids: {},
			extensions: [".remote"],
		});
		const registry = new LspServerRegistry(config.servers);
		expect(registry.forExtension(".REMOTE")?.id).toBe("remote");
	});

	it.each([
		["未列入 extensions", { ".other": "other" }],
		["规范化后重复", { ".DEMO": "one", ".demo": "two" }],
	])("拒绝 language_ids %s", async (_label, language_ids) => {
		const file = path.join(dir, "bad-language-ids.jsonc");
		await writeFile(file, JSON.stringify({
			servers: [{ id: "demo", command: "demo", extensions: [".demo"], language_ids }],
		}));
		process.env.PI_LSP_CONFIG = file;
		await expect(loadLspConfig()).rejects.toThrow(/language_ids extension/);
	});

	it("环境变量覆盖配置路径", async () => {
		const file = path.join(dir, "override.jsonc");
		await writeFile(file, '{ "enabled": false }');
		process.env.PI_LSP_CONFIG = file;
		expect(await loadLspConfig()).toMatchObject({ path: file, config: { enabled: false } });
	});

	it("规范化 exclude_paths 中的用户家目录", () => {
		expect(normalizeExcludePath("~")).toBe(path.resolve(os.homedir()));
		expect(normalizeExcludePath("~/demo")).toBe(path.join(os.homedir(), "demo"));
	});
});
