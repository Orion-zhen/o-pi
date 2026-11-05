import { describe, expect, it } from "vitest";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import type { GuiSessionInfo } from "../../../../src/gui/shared/protocol/state.ts";
import { GuiChannel } from "../../../../src/gui/host/channel.ts";
import { GuiReceiver, type GuiDelivery } from "../../../../src/gui/shared/protocol/sync.ts";

function connection() {
	const deliveries: GuiDelivery[] = [];
	const events: GuiEvent[] = [];
	const receiver = new GuiReceiver();
	const channel = new GuiChannel((delivery) => {
		const wire = JSON.parse(JSON.stringify(delivery)) as GuiDelivery;
		deliveries.push(wire);
		if (wire.kind === "frame") events.push(...wire.events.map((event) => receiver.accept(event)));
	});
	return { channel, deliveries, events, push: async (event: GuiEvent) => { channel.accept(event); await Promise.resolve(); } };
}
const history: GuiSessionInfo[] = Array.from({ length: 400 }, (_, index) => ({
	path: `/project/sessions/${index}.jsonl`, cwd: "/project", title: `会话-${index}`, modified: "2026-09-19T00:00:00Z",
}));
const latest = (events: GuiEvent[]) => events.findLast((event) => event.type === "sessions")?.value;

describe("会话目录传输", () => {
	it("摘要相同不传补丁，正文搜索失效通过独立通知传递", async () => {
		const peer = connection();
		try {
			await peer.push({ type: "sessions", value: history });
			const initial = latest(peer.events);
			await peer.push({ type: "sessions", value: history.map((session) => ({ ...session })) });
			expect(peer.deliveries).toHaveLength(1);
			await peer.push({ type: "historyInvalidated", workspaces: ["/project"] });
			expect(peer.events.at(-1)).toEqual({ type: "historyInvalidated", workspaces: ["/project"] });
			expect(latest(peer.events)).toBe(initial);
			expect(JSON.stringify(peer.deliveries[1]).length).toBeLessThan(150);
		} finally { peer.channel.close(); }
	});
	it("背压期间合并失效工作区，全量失效不被后续局部通知覆盖", async () => {
		const peer = connection();
		try {
			for (let index = 0; index < 4; index++) await peer.push({ type: "historyInvalidated", workspaces: ["/project"] });
			await peer.push({ type: "historyInvalidated", workspaces: ["/a"] });
			await peer.push({ type: "historyInvalidated", workspaces: ["/b"] });
			peer.channel.acknowledge(1);
			await Promise.resolve();
			expect(peer.events.at(-1)).toEqual({ type: "historyInvalidated", workspaces: ["/a", "/b"] });
			await peer.push({ type: "historyInvalidated", workspaces: null });
			await peer.push({ type: "historyInvalidated", workspaces: ["/c"] });
			peer.channel.acknowledge(2);
			await Promise.resolve();
			expect(peer.events.at(-1)).toEqual({ type: "historyInvalidated", workspaces: null });
		} finally { peer.channel.close(); }
	});
	it("首次全量，旧会话完成移到顶部时只传变化内容，保留顺序和未变化对象", async () => {
		const peer = connection();
		try {
			await peer.push({ type: "sessions", value: history });
			const initial = latest(peer.events);
			const changed = [{ path: "/project/sessions/399.jsonl", cwd: "/project", title: "已完成", modified: "2026-09-20T00:00:00Z" }, ...history.slice(0, 399)];
			await peer.push({ type: "sessions", value: changed });
			expect(latest(peer.events)).toEqual(changed);
			expect(initial).toEqual(history);
			expect(latest(peer.events)?.[1]).toBe(initial?.[0]);
			expect(JSON.stringify(peer.deliveries[1]).length).toBeLessThan(JSON.stringify(peer.deliveries[0]).length / 10);
		} finally { peer.channel.close(); }
	});
	it("背压合并期间基于最后发送的目录生成增量，不引用被丢弃的中间状态", async () => {
		const peer = connection();
		try {
			for (let index = 0; index < 10; index++) await peer.push({ type: "sessions", value: history.slice(index) });
			expect(peer.deliveries).toHaveLength(4);
			peer.channel.acknowledge(4);
			await Promise.resolve();
			expect(peer.deliveries).toHaveLength(5);
			expect(latest(peer.events)).toEqual(history.slice(9));
		} finally { peer.channel.close(); }
	});
	it("支持外部删除全部历史、工作区状态变化和重排，重连重新提供全量", async () => {
		const peer = connection();
		try {
			await peer.push({ type: "sessions", value: history });
			await peer.push({ type: "sessions", value: [] });
			expect(latest(peer.events)).toEqual([]);
			await peer.push({ type: "workspaces", value: [{ path: "/a", exists: true }, { path: "/b", exists: true }] });
			const changed = [{ path: "/b", exists: false }, { path: "/c", exists: true }, { path: "/a", exists: true }];
			await peer.push({ type: "workspaces", value: changed });
			expect(peer.events.findLast((event) => event.type === "workspaces")?.value).toEqual(changed);
			const reconnected = connection();
			try {
				await reconnected.push({ type: "sessions", value: history });
				expect(reconnected.deliveries[0]).toEqual({ kind: "frame", id: 1, events: [{ type: "sessions", value: history }] });
			} finally { reconnected.channel.close(); }
		} finally { peer.channel.close(); }
	});
});
