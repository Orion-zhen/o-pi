import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileApprovalStore } from "../../src/approval/store.js";
import type { ApprovalRequest } from "../../src/approval/types.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-approval-store-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("approval store", () => {
	it("addSessionAllowRule 后当前会话命中", () => {
		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRule({ created_at: "t", tool: "bash", kind: "exact_command", value: "git push origin main" });
		expect(store.matchesAllowRule(commandRequest("git push origin main"))).toBe(true);
	});

	it("exact_command 只匹配完全相同命令", () => {
		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRule({ created_at: "t", tool: "bash", kind: "exact_command", value: "git push origin main" });
		expect(store.matchesAllowRule(commandRequest("git push origin main"))).toBe(true);
		expect(store.matchesAllowRule(commandRequest("git push origin dev"))).toBe(false);
	});

	it("command_prefix 匹配前缀命令", () => {
		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRule({ created_at: "t", tool: "bash", kind: "command_prefix", value: "npm install" });
		expect(store.matchesAllowRule(commandRequest("npm install lodash"))).toBe(true);
		expect(store.matchesAllowRule(commandRequest("npm uninstall lodash"))).toBe(false);
	});

	it("exact_path 只匹配同一路径", () => {
		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRule({ created_at: "t", tool: "edit", kind: "exact_path", value: "/etc/hosts" });
		expect(store.matchesAllowRule(pathRequest("edit", "/etc/hosts"))).toBe(true);
		expect(store.matchesAllowRule(pathRequest("edit", "/etc/nginx/nginx.conf"))).toBe(false);
	});

	it("path_glob 匹配子路径", () => {
		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRule({ created_at: "t", tool: "edit", kind: "path_glob", value: "/etc/nginx/**" });
		expect(store.matchesAllowRule(pathRequest("edit", "/etc/nginx/nginx.conf"))).toBe(true);
		expect(store.matchesAllowRule(pathRequest("edit", "/etc/hosts"))).toBe(false);
	});

	it("persistent store 能读写 JSONC 或 JSON 文件", async () => {
		const storePath = path.join(dir, "approval.rules.jsonc");
		const store = new FileApprovalStore(storePath);
		await store.addPersistentAllowRule({ created_at: "t", tool: "bash", kind: "exact_command", value: "git push origin main" });
		expect(await readFile(storePath, "utf8")).toContain('"version": 1');

		const reloaded = new FileApprovalStore(storePath);
		await reloaded.loadPersistentRules();
		expect(reloaded.matchesAllowRule(commandRequest("git push origin main"))).toBe(true);
	});
});

function commandRequest(command: string): ApprovalRequest {
	return {
		id: "1",
		tool: "bash",
		action: "execute",
		summary: command,
		subject: "command",
		targets: [{ kind: "command", value: command }],
		effects: ["execute"],
		raw_input: { command },
	};
}

function pathRequest(tool: "write" | "edit", filePath: string): ApprovalRequest {
	return {
		id: "1",
		tool,
		action: tool === "write" ? "write_file" : "edit_file",
		summary: filePath,
		subject: "path",
		targets: [{ kind: "path", value: filePath }],
		effects: ["write"],
		raw_input: { path: filePath },
	};
}
