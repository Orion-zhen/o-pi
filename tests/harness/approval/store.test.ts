import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";
import { buildApprovalRequest } from "../../../src/harness/approval/pi/request.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import type { ApprovalRequest, ApprovalUnit } from "../../../src/harness/approval/types.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

import { remember } from "./remember.ts";

let dir: string;
const temp = useTempDir("o-pi-approval-store-");

beforeEach(() => {
	dir = temp.path;
});

describe("session approval store", () => {
	it("session exact rule 只匹配同 cwd 的同一子命令", async () => {
		const request = await commandRequest("echo ready && git push origin main");
		const push = unit(request, "git push origin main");
		const store = new SessionApprovalStore();
		remember(store, request, [push]);
		expect(new SessionApprovalStore().matchesAllowRule(request, push)).toBe(false);

		expect(store.matchesAllowRule(request, push)).toBe(true);
		const changedSibling = await commandRequest("echo changed && git push origin main");
		expect(store.matchesAllowRule(changedSibling, unit(changedSibling, "git push origin main"))).toBe(true);
		const changedCommand = await commandRequest("git push origin dev");
		expect(store.matchesAllowRule(changedCommand, unit(changedCommand, "git push origin dev"))).toBe(false);
		const otherCwd = await commandRequest("git push origin main", path.join(dir, "other"));
		expect(store.matchesAllowRule(otherCwd, unit(otherCwd, "git push origin main"))).toBe(false);
	});

	it("会话授权不泛化命令前缀或同目录文件", async () => {
		const store = new SessionApprovalStore();
		const install = await commandRequest("npm install lodash");
		const other = await commandRequest("npm install react");
		remember(store, install);
		expect(store.matchesAllowRule(other, firstUnit(other))).toBe(false);
		const file = await pathRequest("write", path.join(dir, "a.conf"));
		remember(store, file);
		expect(store.matchesAllowRule(file, firstUnit(file))).toBe(true);
		for (const request of [await pathRequest("write", path.join(dir, "b.conf")), await pathRequest("edit", path.join(dir, "a.conf"))]) {
			expect(store.matchesAllowRule(request, firstUnit(request))).toBe(false);
		}
	});

	it("混有不可记忆的单元时不写入部分授权", async () => {
		const request = await commandRequest('git push origin main; cmd=echo; "$cmd" ok');
		const store = new SessionApprovalStore();
		expect(store.prepareRemember(request, request.units)).toBeUndefined();
		const push = unit(request, "git push origin main");
		expect(store.prepareRemember(request, [push])).toBeTypeOf("function");
		expect(store.matchesAllowRule(request, push)).toBe(false);
	});

	it("私网授权只匹配完整 origin", async () => {
		const store = new SessionApprovalStore();
		const request = await webFetchRequest("http://127.0.0.1:8080");
		remember(store, request);
		expect(store.matchesAllowRule(request, firstUnit(request))).toBe(true);
		const other = await webFetchRequest("http://127.0.0.1:9090");
		expect(store.matchesAllowRule(other, firstUnit(other))).toBe(false);
	});
});

function commandRequest(command: string, cwd = dir) {
	return buildBashApprovalRequest(command, { command, cwd, env: {} });
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

async function webFetchRequest(origin: string) {
	const request = await buildApprovalRequest({ type: "tool_call", toolName: "webfetch", toolCallId: "fetch", input: { url: `${origin}/private` } }, dir);
	expect.assert(request?.tool === "webfetch");
	return request;
}
