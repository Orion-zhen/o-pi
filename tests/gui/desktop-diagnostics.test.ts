import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopDiagnostics } from "../../src/desktop/diagnostics.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-desktop-diagnostics-");

describe("桌面耗时日志", () => {
	it("记录请求和累计接收确认，不保存输入、工作区路径或查询内容", async () => {
		const file = path.join(temp.path, "logs", "gui-timing.jsonl");
		const log = new DesktopDiagnostics(file);
		log.reset();
		expect(log.request("send-1", { sessionId: "session-1", value: { action: "prompt", text: "PRIVATE_INPUT", images: [] } }, 100)).toBe(true);
		expect(log.request("query-1", { sessionId: null, value: { query: "image", id: "PRIVATE_IMAGE" } }, 100)).toBe(false);
		log.backend("send-1", 110);
		log.user("session-1", 120, 120);
		expect(log.delivery({ id: 1, events: [{ type: "selected", session: { id: "session-1", cwd: "/PRIVATE_PATH", path: null } }] }, 115)).toBe(true);
		expect(log.delivery({ id: 2, events: [{ type: "patch", sessionId: "session-1", value: {},
			messages: { keep: 0, items: [{ role: "user", content: "PRIVATE_INPUT", timestamp: 120 }] } }] }, 121)).toBe(true);
		log.received(1, 130);
		log.received(2, 131);
		log.acknowledge(2, 140);
		log.acknowledge(2, 145);
		log.result("send-1", false);
		await log.close();
		const text = await readFile(file, "utf8");
		expect(text).not.toContain("PRIVATE_");
		const records: { phase: string; deliveryId?: number; requestId?: string }[] = text.trim().split("\n").map((line) => JSON.parse(line));
		expect(records.map((item) => item.phase)).toEqual([
			"start", "main_received", "backend_received", "user_available", "selection", "user_snapshot", "renderer_received", "renderer_received",
			"renderer_applied", "renderer_applied", "request_settled",
		]);
		expect(records.filter((item) => item.phase === "renderer_applied").map((item) => item.deliveryId)).toEqual([1, 2]);
		expect(records.filter((item) => item.requestId).every((item) => item.requestId === "send-1")).toBe(true);
	});

	it("重连后不把上个连接尚未确认的批次算到新连接", async () => {
		const file = path.join(temp.path, "gui-timing.jsonl");
		const log = new DesktopDiagnostics(file);
		log.delivery({ id: 3, events: [{ type: "selected", session: null }] }, 1);
		log.reset();
		log.received(3, 2);
		log.acknowledge(3, 3);
		await log.close();
		expect(await readFile(file, "utf8")).not.toContain("renderer_");
	});

	it("日志达到上限后轮转，关闭等待此前的并发写入完成", async () => {
		const file = path.join(temp.path, "gui-timing.jsonl");
		const previous = '{"phase":"start"}\n'.repeat(Math.floor(2 * 1024 * 1024 / 18));
		await writeFile(file, previous);
		const log = new DesktopDiagnostics(file);
		for (let index = 0; index < 10; index++) log.request(String(index), { value: { action: "sessions" }, sessionId: null }, 100);
		await log.close();
		expect(await readFile(`${file}.1`, "utf8")).toBe(previous);
		const records: { phase: string; requestId?: string }[] = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(records.filter((item) => item.phase === "main_received").map((item) => item.requestId)).toEqual(Array.from({ length: 10 }, (_, index) => String(index)));
		log.result("after-close", false);
		await log.close();
		expect(await readFile(file, "utf8")).not.toContain("after-close");
	});
});
