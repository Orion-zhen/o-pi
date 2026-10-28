import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseWebArgs } from "../../src/web/cli.ts";

function runCli(args: string[]) {
	return spawnSync("bun", ["src/web/main.ts", ...args], {
		encoding: "utf8",
		timeout: 10_000,
		env: { ...process.env, PI_SUBAGENT_CHILD: "0" },
	});
}

describe("opi-web 命令行", () => {
	it("保留默认配置", () => {
		expect(parseWebArgs([])).toEqual({ host: "0.0.0.0", port: 19198, cwd: process.cwd() });
	});

	it("解析显式配置和 TLS 文件", () => {
		expect(parseWebArgs([
		"--host", "127.0.0.1", "--port=443", "--cwd", "/tmp/project with spaces",
		"--cert", "cert.pem", "--key", "key.pem",
	])).toEqual({ host: "127.0.0.1", port: 443, cwd: "/tmp/project with spaces", cert: "cert.pem", key: "key.pem" });
	});

	it.each(["0", "65535"])("接受边界端口 %s 和 -p", (port) => {
		expect(parseWebArgs(["-p", port]).port).toBe(Number(port));
	});

	it.each(["-h", "--help"])("%s 输出帮助且不启动服务", (flag) => {
		const result = runCli([flag]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		for (const text of ["Usage: opi-web", "--host", "--port", "--cwd", "--cert", "--key", "19198", "0.0.0.0", "请勿暴露到公网"]) {
			expect(result.stdout).toContain(text);
		}
		expect(result.stdout).not.toContain("opi-web: http");
	});

	it.each([
		["--port", ""], ["--port", " "], ["--port", "-1"], ["--port", "65536"],
		["--port", "1.5"], ["--port", "1e3"], ["--port", "0x50"], ["--port", "NaN"],
		["--port", "Infinity"], ["--port", "abc"],
	])("拒绝非法端口 %j %j", (...args) => {
		const result = runCli(args);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("\n    at ");
	});

	it.each([
		["--unknown"], ["--port"], ["project"], ["--cert", "cert.pem"],
		["--key", "key.pem"], ["--cert=", "--key=key.pem"],
	])("拒绝无效参数 %j", (...args) => {
		const result = runCli(args);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toBe("");
		expect(result.stderr).not.toContain("\n    at ");
	});
});
