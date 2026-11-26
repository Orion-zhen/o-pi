import { expect, it, vi } from "vitest";
import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";

vi.mock("node:path", async (load) => ({ default: (await load<typeof import("node:path")>()).win32 }));
vi.mock("node:os", async (load) => ({ default: { ...(await load<typeof import("node:os")>()), tmpdir: () => "D:\\Temp" } }));

function bashRequest(command: string, cwd: string) {
	return buildBashApprovalRequest(command, { command, cwd, env: {} }, { askpass: false });
}

it.each([
	["d:/TEMP/log", "d:/TEMP/log", true],
	["D:/Temp", "D:/Temp", false],
	["D:/Temp/../log", "D:/log", false],
	["C:/Temp/log", "C:/Temp/log", false],
	["//server/share/log", "//server/share/log", false],
	["result.log", "D:/work/result.log", false],
] as const)("按 Windows 宿主路径解析重定向: %s", async (input, expected, temporary) => {
	const request = await bashRequest(`echo ok >"${input}"`, "D:\\work");
	const redirect = request.units.find((unit) => unit.action === "write_redirect");
	expect(redirect?.target).toEqual({ kind: "path", value: expected });
	expect(redirect?.effect_scope).toBe(temporary ? "temporary" : undefined);
});

it("PID 文件名保留 Windows 临时目录约束，不推测 POSIX 挂载点", async () => {
	const request = await bashRequest('echo ok >D:/Temp/log-$$.txt; echo ok >/Temp/log-$$.txt', 'D:/work');
	expect(request.units.filter((unit) => unit.action === "write_redirect")).toMatchObject([
		{ target: { directory: "D:/Temp", numericName: { prefix: "log-", suffix: ".txt" } }, effect_scope: "temporary" },
		{ analysisFact: "shell.run-opaque-input", target: { kind: "command", value: ">/Temp/log-$$.txt" } },
	]);
});

it.each(["/Temp/log", "/d/Temp/log", "D:log", "//?/D:/Temp/log"])("不猜测 Bash 到 Windows 的路径映射: %s", async (input) => {
	const request = await bashRequest(`cd "${input}" && printf ok >result.log`, "D:\\Temp\\work");
	expect(request.units.at(-1)).toMatchObject({ action: "write_redirect", analysisFact: "shell.run-opaque-input", target: { value: ">result.log" } });
});
