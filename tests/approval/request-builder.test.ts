import path from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { buildApprovalRequest } from "../../src/approval/request-builder.js";

const cwd = path.resolve("project");
const systemPath = path.join(path.parse(cwd).root, "etc", "hosts");

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

	it("quoted command text 保留为参数，command substitution 作为独立 unit", async () => {
		const quoted = await buildApprovalRequest(bash(`echo "git push origin main"`), cwd);
		expect(quoted?.units.map((unit) => unit.target.value)).toEqual([`echo "git push origin main"`]);
		const readOnlyRelease = await buildApprovalRequest(bash("gh release view v1.0.0"), cwd);
		expect(readOnlyRelease?.units.map((unit) => unit.target.value)).toEqual(["gh release view v1.0.0"]);
		const spaced = await buildApprovalRequest(bash(`echo   "a  b"`), cwd);
		expect(spaced?.units[0]?.target.value).toBe(`echo "a  b"`);

		const substituted = await buildApprovalRequest(bash(`echo "$(git push origin main)"`), cwd);
		expect(substituted?.units.map((unit) => unit.target.value)).toEqual([
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

	it("env wrapper 同时保留原始和解包后的命令匹配视图", async () => {
		const request = await buildApprovalRequest(bash("env -u NODE_ENV npm install lodash"), cwd);
		expect(request?.units[0]?.target).toMatchObject({
			match_value: "env -u NODE_ENV npm install lodash",
			similar_value: "npm install lodash",
		});
	});

	it("write /etc/hosts 生成路径审批单元", async () => {
		const request = await buildApprovalRequest(write(systemPath), cwd);
		expect(request).toMatchObject({ tool: "write" });
		expect(request?.units[0]).toMatchObject({ action: "write_file", remember: { session: true, persistent: true } });
		expect(request?.units.map((unit) => unit.target)).toEqual([{ kind: "path", value: systemPath.replace(/\\/g, "/") }]);
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

function bash(command: string): ToolCallEvent {
	return { type: "tool_call", toolName: "bash", toolCallId: "bash-1", input: { command } };
}

function write(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "write", toolCallId: "write-1", input: { path: filePath, content: "x" } };
}

function edit(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "edit", toolCallId: "edit-1", input: { path: filePath, edits: [{ old: "a", new: "b" }] } };
}
