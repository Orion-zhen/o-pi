import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";
import { withAskpass } from "../../../src/harness/bash-runtime/askpass.ts";

const run = promisify(execFile);
const options = { env: {}, onData: vi.fn() };
const source = "exec /usr/bin/sudo -A -- echo 'a b'";

async function sudoCommand(command: string, env: NodeJS.ProcessEnv) {
	return (await buildBashApprovalRequest(command, { command, cwd: "/", env }, { askpass: true })).askpassCommand;
}

describe.skipIf(process.platform === "win32")("sudo askpass", () => {
	it("同一次执行按需请求和重试，只有持有调用凭据的助手能读取响应", async () => {
		const ask = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
		const operations = withAskpass({ exec: async (_command, _cwd, options) => {
			const env = options.env;
			const helper = env?.SUDO_ASKPASS;
			if (!helper) throw new Error("缺少 askpass 助手");
			await expect(run(helper, { env: { ...env, OPI_ASKPASS_KEY: "wrong" } })).rejects.toMatchObject({ code: 1, stdout: "" });
			expect(ask).not.toHaveBeenCalled();
			expect((await run(helper, { env })).stdout).toBe("first\n");
			expect((await run(helper, { env })).stdout).toBe("second\n");
			return { exitCode: 0 };
		} }, ask);
		await expect(operations.exec(source, "/", options)).resolves.toEqual({ exitCode: 0 });
		expect(ask.mock.calls.map(([retry]) => retry)).toEqual([false, true]);
	});

	it("免密命令不打开密码框", async () => {
		const ask = vi.fn();
		await withAskpass({ exec: async () => ({ exitCode: 0 }) }, ask).exec(source, "/", options);
		expect(ask).not.toHaveBeenCalled();
	});

	it("取消时助手无密码输出并以失败退出", async () => {
		const result = await withAskpass({ exec: async (_command, _cwd, options) => {
			await expect(run(options.env?.SUDO_ASKPASS ?? "", { env: options.env })).rejects.toMatchObject({ code: 1, stdout: "" });
			return { exitCode: 1 };
		} }, async () => undefined).exec(source, "/", options);
		expect(result.exitCode).toBe(1);
	});

	it("执行超时时撤销等待中的认证，助手不能再获得密码", async () => {
		const opened = Promise.withResolvers<void>();
		let helperExit: Promise<void> | undefined;
		const operations = withAskpass({ exec: async (_command, _cwd, options) => {
			helperExit = expect(run(options.env?.SUDO_ASKPASS ?? "", { env: options.env })).rejects.toMatchObject({ code: 1, stdout: "" });
			await opened.promise;
			throw new Error("timeout:1");
		} }, (_retry, signal) => new Promise((resolve) => {
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
			opened.resolve();
		}));
		await expect(operations.exec(source, "/", options)).rejects.toThrow("timeout:1");
		await helperExit;
	});

	it("续行仍属于同一参数，替换 sudo 前缀不改写参数原文", async () => {
		const args = "printf %s first\\\nsecond";
		expect(await sudoCommand(`sudo ${args}`, {})).toBe(`exec /usr/bin/sudo -A -- ${args}`);
	});

	it("只替换实际执行脚本的 sudo，不接管启动钩子或内嵌 sudo", async () => {
		const command = "sudo cat skill://demo/notes.txt";
		const script = "sudo cat '/skills/demo with space/notes.txt'";
		const request = await buildBashApprovalRequest(command, { command: script, cwd: "/", env: {} }, { askpass: true });
		expect(request.detail.command).toBe(command);
		expect(request.askpassCommand).toBe("exec /usr/bin/sudo -A -- cat '/skills/demo with space/notes.txt'");
		expect(await sudoCommand("sudo id", { BASH_ENV: "init.sh" })).toBeUndefined();
		expect(await sudoCommand("bash -c 'sudo id'", {})).toBeUndefined();
	});

	it("SSH 会话中的静态 sudo 仍使用 askpass", async () => {
		expect(await sudoCommand("sudo id", { SSH_CLIENT: "192.0.2.1 4000 22" })).toBe("exec /usr/bin/sudo -A -- id");
	});

	it("源码不使用从已安装程序继承的助手路径", async () => {
		const { stdout } = await run("bun", ["-e", `import { installationRoot } from "./src/harness/runtime/paths.ts"; console.log(installationRoot())`], {
			env: { ...process.env, PI_OPI_RESOURCE_DIR: "/old-install/resources" },
		});
		expect(stdout.trim()).toBe(process.cwd());
	});

	it.each(["sudo -n id", "sudo cat \"$HOME/report\"", "sudo id | cat", "sudo id >report"])("原样执行 %s", async (command) => {
		expect(await sudoCommand(command, {})).toBeUndefined();
	});
});
