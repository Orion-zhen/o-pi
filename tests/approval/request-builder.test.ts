import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildApprovalRequest } from "../../src/approval/request-builder.js";

const cwd = "/home/orion/project";

describe("approval request builder", () => {
	it("bash 普通命令生成 execute effect", () => {
		const request = buildApprovalRequest(bash("echo hello"), cwd);
		expect(request).toMatchObject({ tool: "bash", action: "execute", effects: ["execute"] });
		expect(request?.targets).toEqual([{ kind: "command", value: "echo hello" }]);
	});

	it("bash git push 生成 publish / network / external_side_effect", () => {
		const request = buildApprovalRequest(bash("git push origin main"), cwd);
		expect(request?.effects).toEqual(expect.arrayContaining(["execute", "publish", "network", "external_side_effect"]));
	});

	it("bash sudo systemctl restart nginx 生成 system_change", () => {
		const request = buildApprovalRequest(bash("sudo systemctl restart nginx"), cwd);
		expect(request?.effects).toEqual(expect.arrayContaining(["execute", "system_change"]));
	});

	it("bash npm install 生成 install / network", () => {
		const request = buildApprovalRequest(bash("npm install lodash"), cwd);
		expect(request?.effects).toEqual(expect.arrayContaining(["execute", "install", "network"]));
	});

	it("write /etc/hosts 生成 write / system_change", () => {
		const request = buildApprovalRequest(write("/etc/hosts"), cwd);
		expect(request).toMatchObject({ tool: "write", action: "write_file" });
		expect(request?.effects).toEqual(expect.arrayContaining(["write", "system_change"]));
		expect(request?.targets).toEqual([{ kind: "path", value: "/etc/hosts" }]);
	});

	it("edit 普通项目文件只生成 write", () => {
		const request = buildApprovalRequest(edit("src/index.ts"), cwd);
		expect(request).toMatchObject({ tool: "edit", action: "edit_file", effects: ["write"] });
		expect(request?.targets).toEqual([{ kind: "path", value: "/home/orion/project/src/index.ts" }]);
	});

	it("read/find/grep/ls 返回 undefined", () => {
		for (const event of [
			{ type: "tool_call", toolName: "read", toolCallId: "read-1", input: { path: "a" } },
			{ type: "tool_call", toolName: "find", toolCallId: "find-1", input: { query: "a" } },
			{ type: "tool_call", toolName: "grep", toolCallId: "grep-1", input: { query: "a" } },
			{ type: "tool_call", toolName: "ls", toolCallId: "ls-1", input: { path: "." } },
		] satisfies ToolCallEvent[]) {
			expect(buildApprovalRequest(event, cwd)).toBeUndefined();
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
