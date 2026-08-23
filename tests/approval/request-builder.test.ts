import os from "node:os";
import path from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { buildApprovalRequest } from "../../src/approval/request/build.js";

const cwd = path.resolve("project");
const systemPath = path.join(path.parse(cwd).root, "etc", "hosts");
const runtimeTempRoot = os.tmpdir();
const runtimeTempChild = path.join(runtimeTempRoot, "pi-approval", "work");

describe("approval request builder", () => {
	it("bash 普通命令生成一个 AST command unit", async () => {
		const request = await buildApprovalRequest(bash("echo hello"), cwd);
		expect(request).toMatchObject({ tool: "bash" });
		expect(request?.units).toHaveLength(1);
		expect(request?.units[0]).toMatchObject({
			target: { kind: "command", value: "echo hello", match_value: "echo hello" },
			remember: { session: true, persistent: true },
		});
	});

	it("复合命令按 pipeline、&& 和重定向拆分", async () => {
		const request = await buildApprovalRequest(
			bash(`echo ready && git push origin main | tee result.log 2>${systemPath}`),
			cwd,
		);
		expect(request?.units.map((unit) => unit.target.value)).toEqual([
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
		const request = await buildApprovalRequest(bash(command), cwd);
		expect(request?.units.map((unit) => unit.target.value)).toEqual(expected);
	});

	it("command substitution 作为独立 unit", async () => {
		const request = await buildApprovalRequest(bash(`echo "$(git push origin main)"`), cwd);
		expect(request?.units.map((unit) => unit.target.value)).toEqual([
			`echo "$(git push origin main)"`,
			"git push origin main",
		]);
	});

	it("literal shell -c 脚本递归解析，动态脚本 fail closed", async () => {
		const literal = await buildApprovalRequest(bash(`bash -c "npm install lodash" && git push origin main`), cwd);
		expect(literal?.units.map((unit) => unit.target.value)).toEqual([
			`bash -c "npm install lodash"`,
			"npm install lodash",
			"git push origin main",
		]);

		const dynamic = await buildApprovalRequest(bash(`bash -c "$SCRIPT"`), cwd);
		expect(dynamic?.units[0]).toMatchObject({
			target: { match_value: "bash -c <dynamic>" },
			remember: { session: true, persistent: false },
		});
	});

	it("语法错误退化为不可持久化的 opaque unit", async () => {
		const request = await buildApprovalRequest(bash(`echo "unterminated`), cwd);
		expect(request?.units).toEqual([
			expect.objectContaining({
				target: expect.objectContaining({ match_value: `<opaque> echo "unterminated` }),
				remember: { session: true, persistent: false },
			}),
		]);
	});

	it.each([
		["审批单元超过限制", Array.from({ length: 257 }, (_value, index) => `echo ${index}`).join("; ")],
		["嵌套 Shell 超过深度限制", nestedShellCommand(9)],
	] as const)("%s时退化为 opaque unit", async (_name, command) => {
		const request = await buildApprovalRequest(bash(command), cwd);
		expect(request?.units).toEqual([
			expect.objectContaining({
				target: expect.objectContaining({ match_value: `<opaque> ${command}` }),
				remember: { session: true, persistent: false },
			}),
		]);
	});

	it("文件写重定向成为 path unit，fd duplication 不成为写文件 unit", async () => {
		const redirected = await buildApprovalRequest(bash("echo hello > output.log 2>&1"), cwd);
		expect(redirected?.units.map((unit) => unit.target)).toEqual([
			{ kind: "command", value: "echo hello", match_value: "echo hello" },
			{ kind: "path", value: path.join(cwd, "output.log").replace(/\\/g, "/") },
		]);

		const numericAndProcess = await buildApprovalRequest(bash("echo hello > 1 > >(cat)"), cwd);
		expect(numericAndProcess?.units.map((unit) => unit.target.value)).toEqual([
			"echo hello",
			path.join(cwd, "1").replace(/\\/g, "/"),
			"cat",
		]);
	});

	it("解析无参数 mktemp 临时文件变量", async () => {
		const request = await buildApprovalRequest(bash(`
log=$(mktemp)
printf content > "$log"
rm -f "$log"
`), cwd);

		expect(request?.units).toEqual(expect.arrayContaining([
			expect.objectContaining({
				action: "write_redirect",
				target: { kind: "path", value: "<temporary>" },
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				target: expect.objectContaining({ match_value: "rm -f <temporary>" }),
				effect_scope: "temporary",
			}),
		]));
	});

	it.each([
		`log=$(mktemp)\nprintf content > "$log/child"`,
		`log=$(mktemp -u)\nprintf content > "$log"`,
	])("不把未证明由 mktemp 独占的新路径标成 temporary: %s", async (command) => {
		const request = await buildApprovalRequest(bash(command), cwd);
		const redirect = request?.units.find((unit) => unit.action === "write_redirect");
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
		const request = await buildApprovalRequest(bash(command), cwd);
		const effect = request?.units.find((unit) => unit.action === "write_redirect" || unit.target.value.includes("rm -rf"));
		expect(effect?.effect_scope).toBe("temporary");
	});

	it("解析 mktemp 临时目录变量并标记仅影响临时目录的单元", async () => {
		const request = await buildApprovalRequest(bash(`
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
`), cwd);

		expect(request?.units).toEqual(expect.arrayContaining([
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
				target: expect.objectContaining({ match_value: "git clean -fd" }),
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				action: "execute",
				target: expect.objectContaining({ match_value: "git reset --hard" }),
				effect_scope: "temporary",
			}),
		]));
		expect(request?.units.flatMap((unit) => unit.target.kind === "command" ? [unit.target.match_value] : [])).toEqual(expect.arrayContaining([
			"xelatex input.txt",
			"lualatex input.txt",
		]));
	});

	it("把系统临时目录后代中的 Bash 文件操作标记为 temporary", async () => {
		const request = await buildApprovalRequest(bash(`
rm -rf "${runtimeTempChild}"
cat > "${path.join(runtimeTempChild, "output.txt")}"
(cd "${runtimeTempChild}" && git clean -fd)
`), cwd);
		expect(request?.units).toEqual(expect.arrayContaining([
			expect.objectContaining({
				target: expect.objectContaining({ match_value: `rm -rf ${runtimeTempChild}` }),
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				target: { kind: "path", value: path.join(runtimeTempChild, "output.txt").replace(/\\/g, "/") },
				effect_scope: "temporary",
			}),
			expect.objectContaining({
				target: expect.objectContaining({ match_value: "git clean -fd" }),
				effect_scope: "temporary",
			}),
		]));
	});

	it.skipIf(process.platform === "win32")("默认识别 /tmp 和 /var/tmp 的后代", async () => {
		for (const command of ["rm -rf /tmp/pi-work", "rm -rf /var/tmp/pi-work"]) {
			const request = await buildApprovalRequest(bash(command), cwd);
			expect(request?.units[0]?.effect_scope).toBe("temporary");
		}
		for (const command of ["rm -rf /tmp", "rm -rf /var/tmp"]) {
			const request = await buildApprovalRequest(bash(command), cwd);
			expect(request?.units[0]?.effect_scope).toBeUndefined();
		}
	});

	it.each([
		`rm -rf "${runtimeTempRoot}"`,
		`rm -rf "${path.join(runtimeTempRoot, "..", "outside")}"`,
	])("不把系统临时目录根或逃逸路径标成 temporary: %s", async (command) => {
		const request = await buildApprovalRequest(bash(command), cwd);
		expect(request?.units[0]?.effect_scope).toBeUndefined();
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
		const request = await buildApprovalRequest(bash(command), cwd);
		const destructive = request?.units.find((unit) => unit.target.value.includes("rm -rf"));
		expect(destructive?.effect_scope).toBeUndefined();
	});

	it("env wrapper 同时保留原始和解包后的命令匹配视图", async () => {
		const request = await buildApprovalRequest(bash("env -u NODE_ENV npm install lodash"), cwd);
		expect(request?.units[0]?.target).toMatchObject({
			match_value: "env -u NODE_ENV npm install lodash",
			similar_value: "npm install lodash",
		});
	});

	it.each([
		["write", write(path.join(runtimeTempRoot, "pi-approval", "file"))],
		["edit", edit(path.join(runtimeTempRoot, "pi-approval", "file"))],
	] as const)("%s 工具把系统临时目录后代标成 temporary", async (_tool, event) => {
		const request = await buildApprovalRequest(event, cwd);
		expect(request?.units[0]?.effect_scope).toBe("temporary");
	});

	it("write /etc/hosts 生成路径审批单元", async () => {
		const request = await buildApprovalRequest(write(systemPath), cwd);
		expect(request).toMatchObject({ tool: "write" });
		expect(request?.units[0]).toMatchObject({ action: "write_file", remember: { session: true, persistent: true } });
		expect(request?.units.map((unit) => unit.target)).toEqual([{ kind: "path", value: systemPath.replace(/\\/g, "/") }]);
	});

	it.each([
		[write("skill://demo/SKILL.md"), "skill://demo/SKILL.md"],
		[edit("skill://demo/references/testing.md"), "skill://demo/references/testing.md"],
	] as const)("技能逻辑路径保持原样供审批规则匹配", async (event, expected) => {
		const request = await buildApprovalRequest(event, cwd);
		expect(request?.units[0]?.target).toMatchObject({ kind: "path", value: expected });
	});

	it("edit 普通项目文件生成路径审批单元", async () => {
		const request = await buildApprovalRequest(edit("src/index.ts"), cwd);
		expect(request).toMatchObject({ tool: "edit" });
		expect(request?.units[0]).toMatchObject({ action: "edit_file", remember: { session: true, persistent: true } });
		expect(request?.units.map((unit) => unit.target)).toEqual([{ kind: "path", value: path.join(cwd, "src", "index.ts").replace(/\\/g, "/") }]);
	});

	it("read/find/grep/ls 返回 undefined", async () => {
		for (const event of [
			{ type: "tool_call", toolName: "read", toolCallId: "read-1", input: { path: "a" } },
			{ type: "tool_call", toolName: "find", toolCallId: "find-1", input: { query: "a" } },
			{ type: "tool_call", toolName: "grep", toolCallId: "grep-1", input: { query: "a" } },
			{ type: "tool_call", toolName: "ls", toolCallId: "ls-1", input: { path: "." } },
		] satisfies ToolCallEvent[]) {
			expect(await buildApprovalRequest(event, cwd)).toBeUndefined();
		}
	});
});

function nestedShellCommand(depth: number): string {
	let command = "echo ok";
	for (let level = 0; level < depth; level += 1) command = `bash -c ${JSON.stringify(command)}`;
	return command;
}

function bash(command: string): ToolCallEvent {
	return { type: "tool_call", toolName: "bash", toolCallId: "bash-1", input: { command } };
}

function write(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "write", toolCallId: "write-1", input: { path: filePath, content: "x" } };
}

function edit(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "edit", toolCallId: "edit-1", input: { path: filePath, edits: [{ old: "a", new: "b" }] } };
}
