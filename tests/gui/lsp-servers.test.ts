import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { readLspServers } from "../../src/gui/host/lsp-servers.ts";
import { preserveEnv } from "../helpers/lifecycle.ts";
import { createProtocolServer, useTransportFixture } from "../harness/lsp/transport/fixtures.ts";

const fixture = useTransportFixture();
preserveEnv("PATH", "PI_LSP_PROJECT_CONFIG", "PI_LSP_PROJECT_ROOT");
beforeEach(() => {
	delete process.env.PI_LSP_PROJECT_CONFIG;
	delete process.env.PI_LSP_PROJECT_ROOT;
});

async function configure(servers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const file = path.join(fixture.configDir, "lsp.jsonc");
	await writeFile(file, JSON.stringify({ ...extra, servers }));
	process.env.PI_LSP_CONFIG = file;
	return file;
}
const languages = { typescript: "*.ts" };
const binaryName = (name: string) => `${name}${process.platform === "win32" ? ".exe" : ""}`;

it("检查全部有效配置的命令，包含禁用项和项目覆盖，不启动进程或连接 TCP", async () => {
	const fake = await createProtocolServer(fixture, {});
	const marker = path.join(fixture.workspace, "started");
	const command = [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`];
	await configure({
		local: { enabled: false, command, languages },
		missing: { command: ["definitely-missing-lsp"], languages: { python: "*.py" } },
	}, { enabled: false, exclude_paths: [fixture.workspace] });
	const project = path.join(fixture.workspace, ".pi", "configs");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "lsp.jsonc"), JSON.stringify({ servers: {
		local: { languages: { javascript: "*.js" } },
		remote: { tcp: { host: "127.0.0.1", port: fake.port }, languages: { go: "*.go" } },
	} }));
	for (let i = 0; i < 2; i++) {
		expect(await readLspServers(fixture.workspace)).toEqual({
			path: path.join(project, "lsp.jsonc"),
			servers: [
				{ id: "local", languages: ["typescript", "javascript"], transport: { type: "stdio", command: process.execPath, args: command.slice(1), executable: process.execPath } },
				{ id: "missing", languages: ["python"], transport: { type: "stdio", command: "definitely-missing-lsp", args: [], executable: null } },
				{ id: "remote", languages: ["go"], transport: { type: "tcp", host: "127.0.0.1", port: fake.port } },
			],
		});
	}
	expect(fake.connections).toBe(0);
	await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("按后端 PATH 顺序查找命令，相对 PATH 和命令路径以工作区为基准", async () => {
	const name = binaryName("test-lsp");
	for (const folder of ["first bin", "second"]) {
		await mkdir(path.join(fixture.workspace, folder));
		await writeFile(path.join(fixture.workspace, folder, name), "not executed", { mode: 0o755 });
	}
	process.env.PATH = ["first bin", "second"].join(path.delimiter);
	await configure({
		byName: { command: [name], languages },
		relative: { command: [`./second/${name}`], languages },
	});
	const result = await readLspServers(fixture.workspace);
	expect(result.servers).toMatchObject([
		{ transport: { executable: path.join(fixture.workspace, "first bin", name) } },
		{ transport: { executable: path.join(fixture.workspace, "second", name) } },
	]);
});

it("刷新重新读取已保存配置和文件，不缓存命令查找结果", async () => {
	const name = binaryName("new-lsp");
	const executable = path.join(fixture.workspace, name);
	const file = await configure({ local: { command: [`./${name}`], languages } });
	const lookup = async () => (await readLspServers(fixture.workspace)).servers;
	expect(await lookup()).toMatchObject([{ transport: { executable: null } }]);
	await writeFile(executable, "not executed", { mode: 0o755 });
	expect(await lookup()).toMatchObject([{ transport: { executable } }]);
	await rm(executable);
	expect(await lookup()).toMatchObject([{ transport: { executable: null } }]);
	await writeFile(file, JSON.stringify({ servers: { local: { command: [process.execPath], languages } } }));
	expect(await lookup()).toMatchObject([{ transport: { executable: process.execPath } }]);
});

it.skipIf(process.platform === "win32")("非可执行文件和目录不算找到命令，符号链接按目标检查权限", async () => {
	const file = path.join(fixture.workspace, "no-exec");
	const link = path.join(fixture.workspace, "link");
	await writeFile(file, "not executed", { mode: 0o644 });
	await symlink(file, link);
	await configure({
		file: { command: [file], languages },
		directory: { command: [fixture.workspace], languages },
		link: { command: [link], languages },
	});
	expect((await readLspServers(fixture.workspace)).servers).toMatchObject([
		{ transport: { executable: null } }, { transport: { executable: null } }, { transport: { executable: null } },
	]);
	await chmod(file, 0o755);
	expect((await readLspServers(fixture.workspace)).servers).toMatchObject([
		{ transport: { executable: file } }, { transport: { executable: null } }, { transport: { executable: link } },
	]);
});

it("配置损坏向查询边界报错，不伪装成命令未找到", async () => {
	const file = await configure({});
	await writeFile(file, "{broken");
	await expect(readLspServers(fixture.workspace)).rejects.toThrow();
});
