import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultLspConfig, loadLspConfig, normalizeExcludePath } from "../../src/lsp/config.js";
import { LspServerRegistry } from "../../src/lsp/registry.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-lsp-config-");
preserveEnv("PI_LSP_CONFIG", "PI_LSP_PROJECT_CONFIG", "PI_LSP_PROJECT_ROOT");

beforeEach(() => {
	dir = temp.path;
});

describe("lsp config", () => {
	it("缺少配置文件采用默认值并规范化内置 glob 路由", async () => {
		process.env.PI_LSP_CONFIG = path.join(dir, "missing.jsonc");
		const loaded = await loadLspConfig();
		expect(loaded).toEqual({ path: path.join(dir, "missing.jsonc"), config: defaultLspConfig() });
		expect(loaded.config.max_open_documents).toBe(64);
		expect(loaded.config.diagnostics.max_related_locations).toBe(2);
		expect(loaded.config.servers[0]).toMatchObject({
			id: "typescript",
			fallback: false,
			routes: [
				{ languageId: "typescript", selectors: ["*.ts"] },
				{ languageId: "typescriptreact", selectors: ["*.tsx"] },
				{ languageId: "javascript", selectors: ["*.{js,mjs,cjs}"] },
				{ languageId: "javascriptreact", selectors: ["*.jsx"] },
			],
		});
		expect(loaded.config.servers.find((server) => server.id === "yaml")?.fallback).toBe(true);
	});

	it("项目配置覆盖全局配置并保留未覆盖的全局字段", async () => {
		const globalPath = path.join(dir, "global.jsonc");
		const projectRoot = path.join(dir, "project");
		const projectPath = path.join(projectRoot, ".pi", "configs", "lsp.jsonc");
		await mkdir(path.dirname(projectPath), { recursive: true });
		await writeFile(globalPath, JSON.stringify({
			request_timeout_ms: 700,
			diagnostics: { max_items: 3 },
			servers: {
				gopls: {
					command: ["gopls"],
					languages: { go: "*.go" },
					settings: { gopls: { staticcheck: true } },
				},
			},
		}));
		await writeFile(projectPath, JSON.stringify({
			request_timeout_ms: 900,
			diagnostics: { min_severity: "error" },
			servers: {
				gopls: {
					settings: { gopls: { gofumpt: true } },
				},
			},
		}));
		process.env.PI_LSP_CONFIG = globalPath;
		const loaded = await loadLspConfig(projectRoot);
		expect(loaded.path).toBe(projectPath);
		expect(loaded.config.request_timeout_ms).toBe(900);
		expect(loaded.config.diagnostics).toMatchObject({ max_items: 3, min_severity: "error" });
		expect(loaded.config.servers).toHaveLength(1);
		expect(loaded.config.servers[0]).toMatchObject({
			id: "gopls",
			transport: { type: "stdio", command: "gopls", args: [] },
			settings: { gopls: { staticcheck: true, gofumpt: true } },
		});
	});

	it("支持 JSONC、trailing comma、字符串 selector 和部分覆盖", async () => {
		const file = path.join(dir, "lsp.jsonc");
		await writeFile(
			file,
			`{
				"exclude_paths": ["~"],
				"request_timeout_ms": 700,
				"diagnostics": { "max_items": 3, "max_related_locations": 1, "min_severity": "error", },
				"servers": {
					"demo": {
						"command": ["demo-lsp", "--stdio"],
						"languages": { "demo": "*.demo", },
					},
				},
			}`,
		);
		process.env.PI_LSP_CONFIG = file;
		expect(await loadLspConfig()).toMatchObject({
			path: file,
			config: {
				request_timeout_ms: 700,
				exclude_paths: [os.homedir()],
				diagnostics: { max_items: 3, max_related_locations: 1, min_severity: "error" },
				servers: [{
					id: "demo",
					enabled: true,
					fallback: false,
					transport: { type: "stdio", command: "demo-lsp", args: ["--stdio"] },
					routes: [{ languageId: "demo", selectors: ["*.demo"] }],
				}],
			},
		});
	});

	it.each([
		["未知顶层字段", { unknown: true }],
		["非法诊断级别", { diagnostics: { min_severity: "fatal" } }],
		["过多 related locations", { diagnostics: { max_related_locations: 11 } }],
		["旧 servers 数组格式", { servers: [{ id: "demo", command: "demo", extensions: [".demo"] }] }],
		["非法 server ID", { servers: { "1demo": { command: ["demo"], languages: { demo: "*.demo" } } } }],
		["空 selector", { servers: { demo: { command: ["demo"], languages: { demo: "" } } } }],
	] as const)("拒绝%s", async (_label, value) => {
		const file = path.join(dir, "bad-schema.jsonc");
		process.env.PI_LSP_CONFIG = file;
		await writeFile(file, JSON.stringify(value));
		await expect(loadLspConfig()).rejects.toThrow("does not match schema");
	});

	it("规范化 command、fallback 和 selector 数组", async () => {
		const file = path.join(dir, "normalized.jsonc");
		await writeFile(file, JSON.stringify({
			servers: {
				demo: {
					fallback: true,
					command: ["demo-lsp", "--stdio"],
					languages: { "demo-special": ["*.demo", "config/**/*.demo"] },
				},
			},
		}));
		process.env.PI_LSP_CONFIG = file;
		const loaded = await loadLspConfig();
		expect(loaded.config.servers).toEqual([{
			id: "demo",
			enabled: true,
			fallback: true,
			transport: { type: "stdio", command: "demo-lsp", args: ["--stdio"] },
			routes: [{ languageId: "demo-special", selectors: ["*.demo", "config/**/*.demo"] }],
		}]);
	});

	it.each(["!*.demo", "../*.demo", "./*.demo", "C:/*.demo", "dir\\*.demo", "@(foo).demo"])(
		"拒绝不安全或不支持的 selector %s",
		async (selector) => {
			const file = path.join(dir, "bad-selector.jsonc");
			await writeFile(file, JSON.stringify({ servers: {
				demo: { command: ["demo"], languages: { demo: selector } },
			} }));
			process.env.PI_LSP_CONFIG = file;
			await expect(loadLspConfig()).rejects.toThrow(/invalid selector/);
		},
	);

	it("basename/path glob、brace 和 fallback 产生确定路由", async () => {
		const registry = await loadRegistry({
			compose: {
				command: ["compose-lsp"],
				languages: { dockercompose: "{compose,docker-compose}{,.override}.{yaml,yml}" },
			},
			yaml: {
				fallback: true,
				command: ["yaml-lsp"],
				languages: { yaml: "*.{yaml,yml}" },
			},
			deploy: {
				command: ["deploy-lsp"],
				languages: { deploy: "deploy/**/*.config" },
			},
		});

		expect(registry.route("nested/compose.yaml")).toMatchObject({ server: { id: "compose" }, languageId: "dockercompose" });
		expect(registry.route("nested/service.yml")).toMatchObject({ server: { id: "yaml" }, languageId: "yaml" });
		expect(registry.route("deploy/prod/app.config")).toMatchObject({ server: { id: "deploy" }, languageId: "deploy" });
		expect(registry.route("other/prod/app.config")).toBeUndefined();
		expect(registry.route("README.md")).toBeUndefined();
	});

	it("selector 大小写敏感", async () => {
		const registry = await loadRegistry({
			clangd: { command: ["clangd"], languages: { c: "*.c", cpp: "*.C" } },
		});
		expect(registry.route("main.c")?.languageId).toBe("c");
		expect(registry.route("main.C")?.languageId).toBe("cpp");
	});

	it.each([
		["多个普通 server", {
			one: { command: ["one"], languages: { one: "*.demo" } },
			two: { command: ["two"], languages: { two: "*.demo" } },
		}],
		["多个 fallback server", {
			one: { fallback: true, command: ["one"], languages: { one: "*.demo" } },
			two: { fallback: true, command: ["two"], languages: { two: "*.demo" } },
		}],
		["同 server 多个 language ID", {
			one: { command: ["one"], languages: { one: "*.demo", two: "special.*" } },
		}],
	] as const)("路由时拒绝%s歧义", async (_label, servers) => {
		const registry = await loadRegistry(servers);
		expect(() => registry.route("special.demo")).toThrow(/multiple|both/);
	});

	it("disabled server 不参与路由", async () => {
		const registry = await loadRegistry({
			disabled: { enabled: false, command: ["one"], languages: { one: "*.demo" } },
			enabled: { command: ["two"], languages: { two: "*.demo" } },
		});
		expect(registry.route("file.demo")?.server.id).toBe("enabled");
	});

	it("保留 TCP endpoint 并按路径选择 server", async () => {
		const file = path.join(dir, "tcp.jsonc");
		await writeFile(file, JSON.stringify({ servers: {
			remote: {
				tcp: { host: "127.0.0.1", port: 2087 },
				languages: { remote: "*.remote" },
			},
		} }));
		process.env.PI_LSP_CONFIG = file;
		const config = (await loadLspConfig()).config;
		expect(config.servers[0]).toMatchObject({
			transport: { type: "tcp", host: "127.0.0.1", port: 2087 },
			routes: [{ languageId: "remote", selectors: ["*.remote"] }],
		});
		const registry = new LspServerRegistry(config.servers);
		expect(registry.route("nested/file.remote")?.server.id).toBe("remote");
	});

	it("拒绝同时配置 command 和 tcp", async () => {
		const file = path.join(dir, "both-transports.jsonc");
		await writeFile(file, JSON.stringify({ servers: {
			demo: {
				command: ["demo"],
				tcp: { host: "127.0.0.1", port: 2087 },
				languages: { demo: "*.demo" },
			},
		} }));
		process.env.PI_LSP_CONFIG = file;
		await expect(loadLspConfig()).rejects.toThrow(/cannot combine command with tcp/);
	});

	it("init 与用户级 settings 分别保留任意 JSON 值", async () => {
		const file = path.join(dir, "array-init.jsonc");
		await writeFile(file, JSON.stringify({ servers: {
			demo: {
				command: ["demo-lsp"],
				languages: { demo: "*.demo" },
				init: ["strict", { feature: true }],
				settings: { demo: { lint: true } },
			},
		} }));
		process.env.PI_LSP_CONFIG = file;

		await expect(loadLspConfig()).resolves.toMatchObject({
			config: { servers: [{
				initializationOptions: ["strict", { feature: true }],
				settings: { demo: { lint: true } },
			}] },
		});
	});

	it.each([
		["空语言路由", { demo: { command: ["demo"], languages: {} } }, /at least one file selector/],
		["超过 50 个 server", Object.fromEntries(Array.from({ length: 51 }, (_, index) => [
			`s${index}`,
			{ command: ["demo"], languages: { demo: `*.x${index}` } },
		])), /more than 50 servers/],
	] as const)("拒绝%s", async (_label, servers, expected) => {
		const file = path.join(dir, "bad-limits.jsonc");
		await writeFile(file, JSON.stringify({ servers }));
		process.env.PI_LSP_CONFIG = file;
		await expect(loadLspConfig()).rejects.toThrow(expected);
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

async function loadRegistry(servers: Record<string, unknown>): Promise<LspServerRegistry> {
	const file = path.join(dir, "routing.jsonc");
	await writeFile(file, JSON.stringify({ servers }));
	process.env.PI_LSP_CONFIG = file;
	return new LspServerRegistry((await loadLspConfig()).config.servers);
}
