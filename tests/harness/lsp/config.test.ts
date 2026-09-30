import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadLspConfig } from "../../../src/harness/lsp/config/loader.ts";
import { LspServerRegistry } from "../../../src/harness/lsp/config/registry.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-lsp-config-");
preserveEnv("PI_LSP_CONFIG", "PI_LSP_PROJECT_CONFIG", "PI_LSP_PROJECT_ROOT");

async function load(value: unknown) {
	const file = path.join(temp.path, "lsp.jsonc");
	process.env.PI_LSP_CONFIG = file;
	await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
	return (await loadLspConfig(temp.path)).config;
}
const server = { command: ["demo", "--stdio"], languages: { demo: "*.demo" } };

it("默认配置能按实际文件名路由，而不锁定全部默认字段", async () => {
	process.env.PI_LSP_CONFIG = path.join(temp.path, "missing.jsonc");
	const config = (await loadLspConfig(temp.path)).config;
	const registry = new LspServerRegistry(config.servers);
	for (const [file, language] of [
		["main.ts", "typescript"], ["web/index.html", "html"], ["package.json", "json"],
		[".eslintrc", "jsonc"], ["styles/theme.scss", "scss"], ["App.java", "java"], ["Cargo.lock", "toml"],
	] as const) expect(registry.route(file)?.languageId).toBe(language);
});

it("用户配置替换默认服务，项目配置合并覆盖并保留未覆盖字段", async () => {
	await load({ request_timeout_ms: 700, diagnostics: { max_items: 3 }, servers: {
		demo: {
			...server,
			settings: { lint: { enabled: true, rules: ["old"] }, format: true },
			init: ["strict", { feature: true }],
		},
	} });
	const project = path.join(temp.path, ".pi", "configs", "lsp.jsonc");
	await mkdir(path.dirname(project), { recursive: true });
	await writeFile(project, JSON.stringify({
		request_timeout_ms: 900, diagnostics: { min_severity: "error" },
		servers: { demo: { settings: { lint: { rules: ["new"] }, format: null }, languages: { demo: ["*.demo", "*.demo2"] } } },
	}));
	const config = (await loadLspConfig(temp.path)).config;
	expect(config.request_timeout_ms).toBe(900);
	expect(config.diagnostics).toMatchObject({ max_items: 3, min_severity: "error" });
	expect(config.servers).toEqual([expect.objectContaining({
		id: "demo", transport: { type: "stdio", command: "demo", args: ["--stdio"] },
		settings: { lint: { enabled: true, rules: ["new"] }, format: null },
		initializationOptions: ["strict", { feature: true }],
		routes: [{ languageId: "demo", selectors: ["*.demo", "*.demo2"] }],
	})]);
});

it("读取带 BOM、注释和尾随逗号的稀疏配置，展开排除路径", async () => {
	const config = await load('\uFEFF{ // local settings\n "exclude_paths": ["~", "~/demo"], "request_timeout_ms": 700, }');
	expect(config.request_timeout_ms).toBe(700);
	expect(config.exclude_paths).toEqual([path.resolve(os.homedir()), path.join(os.homedir(), "demo")]);
});

it("路径选择、候补服务、禁用服务和大小写均影响路由", async () => {
	const config = await load({ servers: {
		compose: { ...server, languages: { dockercompose: "{compose,docker-compose}{,.override}.{yaml,yml}" } },
		yaml: { ...server, fallback: true, languages: { yaml: "*.{yaml,yml}" } },
		deploy: { ...server, languages: { deploy: ["deploy/**/*.config"] } },
		clangd: { ...server, languages: { c: "*.c", cpp: "*.C" } },
		disabled: { ...server, enabled: false, languages: { disabled: "*" } },
	} });
	const registry = new LspServerRegistry(config.servers);
	for (const [file, language] of [
		["nested/compose.yaml", "dockercompose"], ["nested/service.yml", "yaml"],
		["deploy/prod/app.config", "deploy"], ["main.c", "c"], ["main.C", "cpp"],
		["other/prod/app.config", undefined], ["README.md", undefined],
	] as const) expect(registry.route(file)?.languageId).toBe(language);
});

it("TCP 服务保留端点并参与路由", async () => {
	const config = await load({ servers: { remote: { tcp: { host: "127.0.0.1", port: 2087 }, languages: { remote: "*.remote" } } } });
	expect(new LspServerRegistry(config.servers).route("nested/file.remote")?.server.transport)
		.toEqual({ type: "tcp", host: "127.0.0.1", port: 2087 });
});

it("项目覆盖 TCP 服务时必须提供完整端点", async () => {
	await load({ servers: { remote: { tcp: { host: "127.0.0.1", port: 2087 }, languages: { remote: "*.remote" } } } });
	const project = path.join(temp.path, "project.jsonc");
	process.env.PI_LSP_PROJECT_CONFIG = project;
	await writeFile(project, JSON.stringify({ servers: { remote: { tcp: { port: 2088 } } } }));
	await expect(loadLspConfig(temp.path)).rejects.toThrow();
	await writeFile(project, JSON.stringify({ servers: { remote: { tcp: { host: "localhost", port: 2088 } } } }));
	const { config } = await loadLspConfig(temp.path);
	expect(config.servers[0]?.transport).toEqual({ type: "tcp", host: "localhost", port: 2088 });
});

it.each([
	{ unknown: true }, { diagnostics: { min_severity: "fatal" } }, { diagnostics: { max_related_locations: 11 } },
	{ servers: { "1demo": server } }, { servers: { demo: { ...server, languages: { demo: "" } } } },
	{ servers: { demo: { ...server, languages: {} } } },
	{ servers: { demo: { ...server, tcp: { host: "127.0.0.1", port: 2087 } } } },
	{ servers: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`s${index}`, server])) },
])("拒绝无效配置 %j", async (value) => {
	await expect(load(value)).rejects.toThrow();
});

it.each(["!*.demo", "../*.demo", "./*.demo", "C:/*.demo", "dir\\*.demo", "@(foo).demo"])("拒绝不支持的选择规则 %s", async (selector) => {
	await expect(load({ servers: { demo: { ...server, languages: { demo: selector } } } })).rejects.toThrow();
});

it.each([
	{ one: server, two: server },
	{ one: { ...server, fallback: true }, two: { ...server, fallback: true } },
	{ one: { ...server, languages: { one: "*.demo", two: "special.*" } } },
])("拒绝歧义路由 %j", async (servers) => {
	const config = await load({ servers });
	expect(() => new LspServerRegistry(config.servers).route("special.demo")).toThrow();
});
