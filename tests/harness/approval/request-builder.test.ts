import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";
import { buildFileApprovalRequest } from "../../../src/harness/approval/pi/request.ts";

const cwd = path.resolve("project");
const systemPath = path.join(path.parse(cwd).root, "etc", "hosts");
const runtimeTempRoot = os.tmpdir();
const runtimeTempChild = path.join(runtimeTempRoot, "pi-approval", "work");

describe("approval request builder", () => {
	it("bash 普通命令生成一个 AST command unit", async () => {
		const request = await bashRequest("echo hello", cwd);
		expect(request).toMatchObject({ tool: "bash" });
		expect(request.units).toHaveLength(1);
		expect(request.units[0]).toMatchObject({
			target: { kind: "command", value: "echo hello" },
			commands: [["echo", "hello"]],
			remember: true,
		});
	});

	it("复合命令按 pipeline、&& 和重定向拆分", async () => {
		const request = await bashRequest(`echo ready && git push origin main | tee result.log 2>${systemPath.replace(/\\/g, "/")}`, cwd);
		expect(request.units.map((unit) => unit.target.value)).toEqual([
			"echo ready",
			"git push origin main",
			"tee result.log",
			systemPath.replace(/\\/g, "/"),
		]);
	});

	it.each([
		[`echo "git push origin main"`, [`echo "git push origin main"`]],
		["gh release view v1.0.0", ["gh release view v1.0.0"]],
		[`echo   "a  b"`, [`echo "a  b"`]],
	] as const)("静态命令保留预期结构: %s", async (command, expected) => {
		const request = await bashRequest(command, cwd);
		expect(request.units.map((unit) => unit.target.value)).toEqual(expected);
	});

	it("command substitution 作为独立 unit", async () => {
		const request = await bashRequest(`echo "$(git push origin main)"`, cwd);
		expect(request.units.map((unit) => unit.target.value)).toEqual([
			`echo "$(git push origin main)"`,
			"git push origin main",
		]);
	});

	it("literal shell -c 脚本递归解析，动态脚本 fail closed", async () => {
		const literal = await bashRequest(`bash -c "npm install lodash" && git push origin main`, cwd);
		expect(literal.units.map((unit) => unit.target.value)).toEqual([
			`bash -c "npm install lodash"`,
			"npm install lodash",
			"git push origin main",
		]);

		const dynamic = await bashRequest(`read SCRIPT; bash -c "$SCRIPT"`, cwd);
		expect(dynamic.units.at(-1)).toMatchObject({
			analysisFact: "execution.opaque",
			commands: [["bash", "-c", { source: '"$SCRIPT"' }]],
			remember: true,
		});
	});

	it("语法错误退化为不可持久化的 opaque unit", async () => {
		const request = await bashRequest(`echo "unterminated`, cwd);
		expect(request.units).toEqual([
			expect.objectContaining({
				analysisFact: "execution.opaque",
				remember: true,
			}),
		]);
	});

	it("启动状态未知且子脚本解析失败时，只为原命令追加一个 opaque unit", async () => {
		const command = `bash -c 'echo "unfinished'`;
		const request = await buildBashApprovalRequest(command, { cwd, command, env: { BASH_ENV: "init.sh" } });
		expect(request.units.map(({ analysisFact }) => analysisFact)).toEqual([undefined, "execution.opaque"]);
		expect(request.allowSessionMemory).toBe(false);
	});

	it.each([
		["审批单元超过限制", Array.from({ length: 257 }, (_value, index) => `echo ${index}`).join("; ")],
		["嵌套 Shell 超过深度限制", nestedShellCommand(9)],
	] as const)("%s时保留已分析的命令，并追加 opaque unit", async (_name, command) => {
		const request = await bashRequest(command, cwd);
		expect(request.units[0]?.target.kind).toBe("command");
		expect(request.units.length).toBeGreaterThan(1);
		expect(request.units.at(-1)).toMatchObject({ analysisFact: "execution.opaque", remember: true });
	});

	it("技能路径替换前后的写入目标均参与审批，展示仍使用原命令", async () => {
		const command = 'echo >"skill://demo/result"';
		const resolved = `${cwd.replaceAll("\\", "/")}/skills/demo/result`;
		const script = `echo >'${resolved}'`;
		const request = await buildBashApprovalRequest(command, { cwd, command: script, env: {} });
		expect(request.detail.command).toBe(command);
		expect(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value))
			.toEqual(["skill://demo/result", resolved]);
		expect(request.units.at(-1)).toMatchObject({ target: { value: command }, remember: false });
	});

	it("文件写重定向成为 path unit，fd duplication 不成为写文件 unit", async () => {
		const redirected = await bashRequest("echo hello > output.log 2>&1", cwd);
		expect(redirected.units.map((unit) => unit.target)).toEqual([
			{ kind: "command", value: "echo hello" },
			{ kind: "path", value: path.join(cwd, "output.log").replace(/\\/g, "/") },
		]);

		const numericAndProcess = await bashRequest("echo hello > 1 > >(cat)", cwd);
		expect(numericAndProcess?.units.map((unit) => unit.target.value)).toEqual([
			"echo hello",
			path.join(cwd, "1").replace(/\\/g, "/"),
			"cat",
		]);
	});

	it.each(["'log-$$'", "log-\\$\\$"])("没有 PID 展开的文件名仍是精确路径: %s", async (name) => {
		const request = await bashRequest(`echo ok >${name}`, cwd);
		expect(request.units[1]?.target).toEqual({ kind: "path", value: path.join(cwd, "log-$$").replaceAll("\\", "/") });
	});

	it("解析无参数 mktemp 临时文件变量", async () => {
		const request = await bashRequest(`
log=$(mktemp)
printf content > "$log"
rm -f "$log"
`, cwd);

		expect(request.units).toEqual(expect.arrayContaining([
			expect.objectContaining({
				action: "write_redirect",
				target: { kind: "path", value: "<temporary>" },
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				target: expect.objectContaining({ value: 'rm -f "$log"' }),
				effect_scope: "temporary",
			}),
		]));
	});

	it.each([
		`log=$(mktemp)\nprintf content > "$log/child"`,
		`log=$(mktemp -u)\nprintf content > "$log"`,
	])("不把未证明由 mktemp 独占的新路径标成 temporary: %s", async (command) => {
		const request = await bashRequest(command, cwd);
		const redirect = request.units.find((unit) => unit.action === "write_redirect");
		expect(redirect).toMatchObject({ target: { kind: "command" } });
		expect(redirect?.effect_scope).toBeUndefined();
	});

	it.each([
		`log=$(mktemp cache.XXXX)\nprintf content > "$log"`,
		`log=$(mktemp --tmpdir=/tmp --suffix=.ts)\nprintf content > "$log"`,
		`log=$(mktemp --suffix .ts)\nprintf content > "$log"`,
		`log=$(mktemp -p /tmp cache.XXXX)\nprintf content > "$log"`,
		`tmpdir=$(mktemp -d ./cache.XXXX)\nrm -rf "$tmpdir"`,
	])("把静态 mktemp 变体创建的新路径标成 temporary: %s", async (command) => {
		const request = await bashRequest(command, cwd);
		const effect = request.units.find((unit) => unit.action === "write_redirect" || unit.target.value.includes("rm -rf"));
		expect(effect?.effect_scope).toBe("temporary");
	});

	it("解析 mktemp 临时目录变量并标记仅影响临时目录的单元", async () => {
		const request = await bashRequest(`
tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT
cat > "$tmpdir/input.txt" <<'EOF'
content
EOF
for engine in xelatex lualatex; do
	(cd "$tmpdir" && "$engine" input.txt > result.txt)
done
(cd "$tmpdir" && git clean -fd && git reset --hard)
`, cwd);

		expect(request.units).toEqual(expect.arrayContaining([
			expect.objectContaining({
				action: "execute",
				target: expect.objectContaining({ value: `rm -rf "$tmpdir"` }),
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				action: "write_redirect",
				target: { kind: "path", value: "<temporary>/input.txt" },
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				action: "write_redirect",
				target: { kind: "path", value: "<temporary>/result.txt" },
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				action: "execute",
				commands: [["git", "clean", "-fd"]],
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				action: "execute",
				commands: [["git", "reset", "--hard"]],
				effect_scope: "temporary",
			}),
		]));
		expect(request.units.flatMap((unit) => unit.commands ?? [])).toEqual(expect.arrayContaining([
			["xelatex", "input.txt"],
			["lualatex", "input.txt"],
		]));
	});

	it("把系统临时目录后代中的 Bash 文件操作标记为 temporary", async () => {
		const request = await bashRequest(`
rm -rf "${runtimeTempChild}"
cat > "${path.join(runtimeTempChild, "output.txt")}"
(cd "${runtimeTempChild}" && git clean -fd)
`, cwd);
		expect(request.units).toEqual(expect.arrayContaining([
			expect.objectContaining({
				commands: [["rm", "-rf", runtimeTempChild]],
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				target: { kind: "path", value: path.join(runtimeTempChild, "output.txt").replace(/\\/g, "/") },
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				commands: [["git", "clean", "-fd"]],
				effect_scope: "temporary",
			}),
		]));
	});

	it("不把与临时根同前缀的相邻目录标成 temporary", async () => {
		const sibling = path.join(`${runtimeTempRoot}-other`, "work");
		const request = await bashRequest(`rm -rf "${sibling}"`, cwd);
		expect(request.units[0]?.effect_scope).toBeUndefined();
	});

	it.each([
		`rm -rf "${runtimeTempRoot}"`,
		`rm -rf "${path.join(runtimeTempRoot, "..", "outside")}"`,
	])("不把系统临时目录根或逃逸路径标成 temporary: %s", async (command) => {
		const request = await bashRequest(command, cwd);
		expect(request.units[0]?.effect_scope).toBeUndefined();
	});

	it.each([
		`tmpdir=/etc\nrm -rf "$tmpdir"`,
		`tmpdir='<temporary>'\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\ntmpdir=/etc\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nread tmpdir\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nfor tmpdir in /etc; do rm -rf "$tmpdir"; done`,
		`tmpdir=$(mktemp -d)\nrm -rf "$tmpdir" /etc/hosts`,
		`tmpdir=$(mktemp -d)\nsudo rm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nrm -rf "$tmpdir/../outside"`,
		`tmpdir=$(mktemp -d)\n(cd "$tmpdir"; rm -rf .)`,
		`tmpdir=$(mktemp -d)\n(cd "$tmpdir" && git -C /etc clean -fd)`,
	])("不把未证明仅影响临时目录的命令标成 temporary: %s", async (command) => {
		const request = await bashRequest(command, cwd);
		const destructive = request.units.find((unit) => unit.target.value.includes("rm -rf"));
		expect(destructive?.effect_scope).toBeUndefined();
	});

	it("env wrapper 保留命令原文与解包后的有效命令", async () => {
		const request = await bashRequest("env -u NODE_ENV npm install lodash", cwd);
		expect(request.units[0]).toMatchObject({
			target: { value: "env -u NODE_ENV npm install lodash" },
			commands: [["env", "-u", "NODE_ENV", "npm", "install", "lodash"], ["npm", "install", "lodash"]],
		});
	});

	it.each([
		["write", write(path.join(runtimeTempRoot, "pi-approval", "file"))],
		["edit", edit(path.join(runtimeTempRoot, "pi-approval", "file"))],
	] as const)("%s 工具把系统临时目录后代标成 temporary", async (_tool, event) => {
		const request = buildFileApprovalRequest(event, cwd);
		expect(request.unit.effect_scope).toBe("temporary");
	});

	it.each([write("~/.config/approval-test"), edit("~/.config/approval-test")])("文件工具审批与实际路径解析使用相同的 home 展开", async (event) => {
		const request = buildFileApprovalRequest(event, cwd);
		expect(request.unit.target).toEqual({
			kind: "path",
			value: path.join(os.homedir(), ".config", "approval-test").replaceAll("\\", "/"),
		});
	});

	it("Bash 引号内的波浪号仍是字面路径", async () => {
		const request = await bashRequest('echo value > "~/approval-test"', cwd);
		expect(request.units[1]?.target).toEqual({
			kind: "path",
			value: path.join(cwd, "~", "approval-test").replaceAll("\\", "/"),
		});
	});

	it("write /etc/hosts 生成路径审批单元", async () => {
		const request = buildFileApprovalRequest(write(systemPath), cwd);
		expect(request).toMatchObject({ tool: "write" });
		expect(request.unit).toMatchObject({ action: "write_file", remember: true });
		expect(request.unit.target).toEqual({ kind: "path", value: systemPath.replace(/\\/g, "/") });
	});

	it.each([
		[write("skill://demo/SKILL.md"), "skill://demo/SKILL.md"],
		[edit("skill://demo/references/testing.md"), "skill://demo/references/testing.md"],
	] as const)("技能逻辑路径保持原样供审批规则匹配", async (event, expected) => {
		const request = buildFileApprovalRequest(event, cwd);
		expect(request.unit.target).toMatchObject({ kind: "path", value: expected });
	});

	it("edit 普通项目文件生成路径审批单元", async () => {
		const request = buildFileApprovalRequest(edit("src/index.ts"), cwd);
		expect(request).toMatchObject({ tool: "edit" });
		expect(request.unit).toMatchObject({ action: "edit_file", remember: true });
		expect(request.unit.target).toEqual({ kind: "path", value: path.join(cwd, "src", "index.ts").replace(/\\/g, "/") });
	});

});

function bashRequest(command: string, cwd: string) {
	return buildBashApprovalRequest(command, { command, cwd, env: {} });
}

function nestedShellCommand(depth: number): string {
	let command = "echo ok";
	for (let level = 0; level < depth; level += 1) command = `bash -c ${JSON.stringify(command)}`;
	return command;
}

function write(filePath: string) {
	return { type: "tool_call" as const, toolName: "write" as const, toolCallId: "write-1", input: { path: filePath, content: "x" } };
}

function edit(filePath: string) {
	return { type: "tool_call" as const, toolName: "edit" as const, toolCallId: "edit-1", input: { path: filePath, edits: [{ old: "a", new: "b" }] } };
}
