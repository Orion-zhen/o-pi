import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { buildApprovalRequest } from "../../src/approval/request/build.js";
import { createExactAllowRules, createSimilarAllowRules } from "../../src/approval/rules/allow.js";
import { FileApprovalStore } from "../../src/approval/rules/store.js";
import type { ApprovalRequest, ApprovalUnit } from "../../src/approval/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-approval-store-");

beforeEach(() => {
	dir = temp.path;
});

describe("approval store", () => {
	it("session exact rule 只匹配同 cwd 的同一子命令", async () => {
		const request = await commandRequest("echo ready && git push origin main");
		const push = unit(request, "git push origin main");
		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRules(createExactAllowRules(request, [push]));

		expect(store.matchesAllowRule(request, push)).toBe(true);
		const changedSibling = await commandRequest("echo changed && git push origin main");
		expect(store.matchesAllowRule(changedSibling, unit(changedSibling, "git push origin main"))).toBe(true);
		const changedCommand = await commandRequest("git push origin dev");
		expect(store.matchesAllowRule(changedCommand, unit(changedCommand, "git push origin dev"))).toBe(false);
		const otherCwd = await commandRequest("git push origin main", path.join(dir, "other"));
		expect(store.matchesAllowRule(otherCwd, unit(otherCwd, "git push origin main"))).toBe(false);
	});

	it("package install 的 similar rule 使用保守前缀且不覆盖相邻 command unit", async () => {
		const request = await commandRequest("npm install lodash && git push origin main");
		const install = unit(request, "npm install lodash");
		const rules = createSimilarAllowRules(request, [install]);
		expect(rules).toEqual([
			expect.objectContaining({ kind: "command_prefix", value: "npm install", cwd: request.cwd }),
		]);

		const store = new FileApprovalStore(path.join(dir, "rules.jsonc"));
		store.addSessionAllowRules(rules);
		const similar = await commandRequest("npm install react && git push origin dev");
		expect(store.matchesAllowRule(similar, unit(similar, "npm install react"))).toBe(true);
		expect(store.matchesAllowRule(similar, unit(similar, "git push origin dev"))).toBe(false);
	});

	it("git push 的 similar rule 保持精确，不生成宽前缀", async () => {
		const request = await commandRequest("git push origin main");
		expect(createSimilarAllowRules(request, request.units)).toEqual([
			expect.objectContaining({ kind: "exact_command", value: "git push origin main" }),
		]);
	});

	it("exact_path 和 path_glob 匹配对应 path unit", async () => {
		const nginx = systemPath("etc", "nginx", "nginx.conf");
		const request = await pathRequest("edit", nginx);
		const exactStore = new FileApprovalStore(path.join(dir, "exact.jsonc"));
		exactStore.addSessionAllowRules(createExactAllowRules(request, request.units));
		expect(exactStore.matchesAllowRule(request, firstUnit(request))).toBe(true);

		const similarRules = createSimilarAllowRules(request, request.units);
		if (process.platform === "win32") {
			expect(similarRules).toEqual([expect.objectContaining({ kind: "exact_path", value: nginx.replaceAll("\\", "/") })]);
			return;
		}
		expect(similarRules).toEqual([expect.objectContaining({ kind: "path_glob", value: "/etc/nginx/**" })]);
		const similarStorePath = path.join(dir, "similar.jsonc");
		const similarStore = new FileApprovalStore(similarStorePath);
		await similarStore.addPersistentAllowRules(similarRules);
		const reloaded = new FileApprovalStore(similarStorePath);
		await reloaded.loadPersistentRules();
		const sibling = await pathRequest("edit", systemPath("etc", "nginx", "sites", "app.conf"));
		expect(reloaded.matchesAllowRule(sibling, firstUnit(sibling))).toBe(true);
		const hosts = await pathRequest("edit", systemPath("etc", "hosts"));
		expect(reloaded.matchesAllowRule(hosts, firstUnit(hosts))).toBe(false);
	});

	it("webfetch 会话和持久规则只允许相同 origin", async () => {
		const request = webFetchRequest("http://127.0.0.1:8080");
		const rules = createSimilarAllowRules(request, request.units);
		expect(rules).toEqual([{ tool: "webfetch", kind: "exact_url", value: "http://127.0.0.1:8080" }]);

		const storePath = path.join(dir, "webfetch.rules.jsonc");
		const store = new FileApprovalStore(storePath);
		await store.addPersistentAllowRules(rules);
		const reloaded = new FileApprovalStore(storePath);
		await reloaded.loadPersistentRules();
		expect(reloaded.matchesAllowRule(request, firstUnit(request))).toBe(true);
		const other = webFetchRequest("http://127.0.0.1:9090");
		expect(reloaded.matchesAllowRule(other, firstUnit(other))).toBe(false);
	});

	it("persistent store 批量读写带 cwd 的规则", async () => {
		const request = await commandRequest("git push origin main && npm install lodash");
		const storePath = path.join(dir, "approval.rules.jsonc");
		const store = new FileApprovalStore(storePath);
		await store.addPersistentAllowRules(createSimilarAllowRules(request, request.units));
		const text = await readFile(storePath, "utf8");
		expect(text).not.toContain('"version"');
		expect(text).toContain('"cwd"');

		const reloaded = new FileApprovalStore(storePath);
		await reloaded.loadPersistentRules();
		for (const commandUnit of request.units) expect(reloaded.matchesAllowRule(request, commandUnit)).toBe(true);
	});

	it("并发持久写入串行提交且不丢规则", async () => {
		const first = await commandRequest("git push origin main");
		const second = await commandRequest("npm install lodash");
		const storePath = path.join(dir, "concurrent.rules.jsonc");
		const store = new FileApprovalStore(storePath);
		await Promise.all([
			store.addPersistentAllowRules(createExactAllowRules(first, first.units)),
			store.addPersistentAllowRules(createExactAllowRules(second, second.units)),
		]);
		const reloaded = new FileApprovalStore(storePath);
		await reloaded.loadPersistentRules();
		expect(reloaded.matchesAllowRule(first, unit(first, "git push origin main"))).toBe(true);
		expect(reloaded.matchesAllowRule(second, unit(second, "npm install lodash"))).toBe(true);
	});

	it("按字段读取旧持久文件并丢弃无 cwd 的旧命令规则", async () => {
		const storePath = path.join(dir, "legacy.rules.jsonc");
		await writeFile(storePath, JSON.stringify({
			version: 1,
			rules: [
				{ created_at: "2026-01-01T00:00:00.000Z", tool: "bash", kind: "exact_command", value: "git push origin main" },
				{ created_at: "2026-01-01T00:00:00.000Z", tool: "bash", kind: "exact_command", value: "npm publish", cwd: dir },
				{ created_at: "2026-01-01T00:00:00.000Z", tool: "edit", kind: "exact_path", value: "/etc/hosts" },
			],
		}));
		const store = new FileApprovalStore(storePath);
		await store.loadPersistentRules();

		const globalCommand = await commandRequest("git push origin main");
		expect(store.matchesAllowRule(globalCommand, firstUnit(globalCommand))).toBe(false);
		const scopedCommand = await commandRequest("npm publish");
		expect(store.matchesAllowRule(scopedCommand, firstUnit(scopedCommand))).toBe(true);
		const hosts = await pathRequest("edit", systemPath("etc", "hosts"));
		expect(store.matchesAllowRule(hosts, firstUnit(hosts))).toBe(process.platform !== "win32");
	});

});

function systemPath(...segments: string[]): string {
	return path.join(path.parse(dir).root, ...segments);
}

async function commandRequest(command: string, cwd = dir): Promise<ApprovalRequest> {
	const request = await buildApprovalRequest(
		{ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command } },
		cwd,
	);
	if (request === undefined) throw new Error("command request was not built");
	return request;
}

async function pathRequest(tool: "write" | "edit", filePath: string): Promise<ApprovalRequest> {
	const event = tool === "write"
		? { type: "tool_call" as const, toolName: "write" as const, toolCallId: "1", input: { path: filePath, content: "x" } }
		: { type: "tool_call" as const, toolName: "edit" as const, toolCallId: "1", input: { path: filePath, edits: [{ old: "a", new: "b" }] } };
	const request = await buildApprovalRequest(event, dir);
	if (request === undefined) throw new Error("path request was not built");
	return request;
}

function unit(request: ApprovalRequest, value: string): ApprovalUnit {
	const found = request.units.find((candidate) => candidate.target.value === value);
	if (found === undefined) throw new Error(`missing approval unit: ${value}`);
	return found;
}

function firstUnit(request: ApprovalRequest): ApprovalUnit {
	const found = request.units[0];
	if (found === undefined) throw new Error("missing approval unit");
	return found;
}

function webFetchRequest(origin: string): ApprovalRequest {
	return {
		tool: "webfetch",
		cwd: dir,
		summary: `Fetch private network origin: ${origin}`,
		detail: {
			kind: "webfetch",
			url: `${origin}/private`,
			origin,
			addresses: [{ address: "127.0.0.1", family: 4 }],
		},
		units: [{
			action: "fetch_url",
			target: { kind: "url", value: origin },
			remember: { session: true, persistent: true },
		}],
	};
}
