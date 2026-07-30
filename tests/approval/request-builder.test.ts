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
			effects: ["execute"],
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
		expect(request?.units[1]?.effects).toEqual(expect.arrayContaining(["publish", "network", "external_side_effect"]));
		expect(request?.units[3]?.effects).toEqual(["write", "system_change"]);
	});

	it("quoted command text 不会误判，command substitution 会作为独立 unit", async () => {
		const quoted = await buildApprovalRequest(bash(`echo "git push origin main"`), cwd);
		expect(allEffects(quoted)).toEqual(["execute"]);
		const readOnlyRelease = await buildApprovalRequest(bash("gh release view v1.0.0"), cwd);
		expect(allEffects(readOnlyRelease)).toEqual(["execute"]);
		const spaced = await buildApprovalRequest(bash(`echo   "a  b"`), cwd);
		expect(spaced?.units[0]?.target.value).toBe(`echo "a  b"`);

		const substituted = await buildApprovalRequest(bash(`echo "$(git push origin main)"`), cwd);
		expect(substituted?.units.map((unit) => unit.target.value)).toEqual([
			`echo "$(git push origin main)"`,
			"git push origin main",
		]);
		expect(substituted?.units[0]?.effects).toEqual(["execute"]);
		expect(substituted?.units[1]?.effects).toContain("publish");
	});

	it("literal shell -c 脚本递归解析，动态脚本 fail closed", async () => {
		const literal = await buildApprovalRequest(bash(`bash -c "npm install lodash" && git push origin main`), cwd);
		expect(literal?.units.map((unit) => unit.target.value)).toEqual([
			`bash -c "npm install lodash"`,
			"npm install lodash",
			"git push origin main",
		]);
		expect(allEffects(literal)).toEqual(expect.arrayContaining(["install", "publish"]));

		const dynamic = await buildApprovalRequest(bash(`bash -c "$SCRIPT"`), cwd);
		expect(allEffects(dynamic)).toContain("unknown_side_effect");
	});

	it("语法错误退化为不可持久化的 opaque unit", async () => {
		const request = await buildApprovalRequest(bash(`echo "unterminated`), cwd);
		expect(request?.units).toEqual([
			expect.objectContaining({
				effects: ["execute", "unknown_side_effect"],
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

	it.each([
		["git push origin main", ["publish", "network", "external_side_effect"]],
		["git -C repo push origin main", ["publish"]],
		["sudo systemctl restart nginx", ["system_change"]],
		["sudo -u root npm install lodash", ["system_change", "install"]],
		["env -u NODE_ENV npm install lodash", ["install"]],
		["npm install lodash", ["install", "network"]],
		["pacman -Syu", ["install"]],
		["rm -r -f build", ["destructive"]],
		["kubectl apply -f deploy.yaml", ["external_side_effect"]],
		["kubectl -n production apply -f deploy.yaml", ["external_side_effect"]],
		["docker --context remote rm container-id", ["external_side_effect"]],
	] as const)("bash effect classifier: %s", async (command, effects) => {
		const request = await buildApprovalRequest(bash(command), cwd);
		expect(allEffects(request)).toEqual(expect.arrayContaining([...effects]));
	});

	it("write /etc/hosts 生成 write / system_change", async () => {
		const request = await buildApprovalRequest(write(systemPath), cwd);
		expect(request).toMatchObject({ tool: "write" });
		expect(request?.units[0]).toMatchObject({ action: "write_file", effects: ["write", "system_change"] });
		expect(request?.units.map((unit) => unit.target)).toEqual([{ kind: "path", value: systemPath.replace(/\\/g, "/") }]);
	});

	it("edit 普通项目文件只生成 write", async () => {
		const request = await buildApprovalRequest(edit("src/index.ts"), cwd);
		expect(request).toMatchObject({ tool: "edit" });
		expect(request?.units[0]).toMatchObject({ action: "edit_file", effects: ["write"] });
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

function allEffects(request: Awaited<ReturnType<typeof buildApprovalRequest>>): string[] {
	return [...new Set(request?.units.flatMap((unit) => unit.effects) ?? [])];
}
