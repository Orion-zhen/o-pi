import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionSearch } from "../../../../../src/gui/frontend/features/sessions/use-session-search.ts";
import { SearchExcerptText } from "../../../../../src/gui/frontend/features/sessions/search-excerpt.tsx";
import type { GuiConnection } from "../../../../../src/gui/shared/protocol/connection.ts";
import type { GlobalQuery, Query } from "../../../../../src/gui/shared/protocol/queries.ts";
import type { SessionSearchPage } from "../../../../../src/gui/shared/session-search.ts";
import { useReactFixture } from "../../../helpers/react-fixture.ts";
import { deferred } from "../../../../helpers/async.ts";

const render = useReactFixture();
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const query = vi.fn<Query<GlobalQuery>>();
const send = vi.fn<GuiConnection["send"]>();
const report = vi.fn();
beforeEach(() => { query.mockReset(); send.mockReset().mockResolvedValue(undefined); report.mockReset(); });
function View({ cwd = "/project", connected = true }: { cwd?: string; connected?: boolean }) {
	const search = useSessionSearch(cwd, connected, undefined, query, send, report);
	return <>
		<button onClick={() => search.setText("中文")}>中文</button>
		<button onClick={() => search.setText("另一个")}>另一个</button>
		<button onClick={() => search.setText("")}>清空</button>
		<output data-state={search.result?.state ?? "idle"}>{search.text}|{search.result?.state === "error" ? search.result.message : ""}
			{search.result?.hits.map((hit) => <span key={hit.path}><SearchExcerptText value={hit.excerpt} /></span>)}
		</output>
	</>;
}
const page = (id: string, done = false): SessionSearchPage => ({ id, hits: [], done, total: done ? 0 : 2, scanned: 0 });
async function click(name: string) {
	const button = [...document.querySelectorAll("button")].find((button) => button.textContent === name);
	await act(async () => button?.click());
}
async function tick() { await act(async () => vi.advanceTimersByTimeAsync(250)); }

it("正文摘要保留来源、词间空白和 Unicode 高亮，前文可独立裁剪", async () => {
	const prefix = "…前文说明 ";
	const first = "大小";
	const between = "之间还有一些说明";
	const second = "𠮷😀中文";
	const text = prefix + first + between + second + "后文";
	const next = prefix.length + first.length + between.length;
	await render(<SearchExcerptText label="助手: " value={{ text, ranges: [[prefix.length, prefix.length + first.length], [next, next + second.length]] }} />);
	expect(document.querySelector(".search-excerpt-prefix")?.textContent).toBe("助手: …前文说明\u00a0");
	expect(document.querySelector(".search-excerpt-match")?.textContent).toBe(first + between + second + "后文");
	expect([...document.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([first, second]);
});

it("输入防抖，首批显示后才拉取下一批，清空立即恢复并取消在途查询", async () => {
	const next = deferred<SessionSearchPage>();
	query.mockResolvedValueOnce({ ...page("first"), scanned: 1, hits: [{ path: "one", source: "user", excerpt: { text: "中文片段", ranges: [[0, 2]] } }] })
		.mockReturnValueOnce(next.promise);
	await render(<View />);
	await click("中文");
	expect(query).not.toHaveBeenCalled();
	await tick();
	expect(query.mock.calls.map(([value]) => value.query)).toEqual(["searchSessions", "continueSessionSearch"]);
	expect(document.querySelector("mark")?.textContent).toBe("中文");
	expect(document.querySelector(".search-excerpt-prefix")).toBeNull();
	expect(document.querySelector("output")?.dataset.state).toBe("searching");
	await click("清空");
	expect(document.querySelector("output")?.dataset.state).toBe("idle");
	expect(send).toHaveBeenCalledWith({ action: "cancelSessionSearch", id: "first" }, null);
	await act(async () => next.resolve({ ...page("first", true), scanned: 2, total: 2, hits: [{ path: "late", source: "user", excerpt: { text: "过时结果", ranges: [[0, 2]] } }] }));
	expect(document.body.textContent).not.toContain("过时结果");
	expect(send).toHaveBeenCalledTimes(1);
});

it("旧任务尚未返回标识时也会在返回后取消，不能覆盖新查询", async () => {
	const first = deferred<SessionSearchPage>();
	query.mockReturnValueOnce(first.promise).mockResolvedValueOnce(page("second", true));
	await render(<View />);
	await click("中文"); await tick();
	await click("另一个"); await tick();
	expect(document.querySelector("output")?.dataset.state).toBe("done");
	await act(async () => first.resolve(page("first")));
	expect(send).toHaveBeenCalledWith({ action: "cancelSessionSearch", id: "first" }, null);
	expect(query).toHaveBeenCalledTimes(2);
	expect(document.querySelector("output")?.textContent).toBe("另一个|");
});

it("工作区切换清空输入，不恢复上一个工作区的旧搜索", async () => {
	query.mockResolvedValue(page("first", true));
	await render(<View />);
	await click("中文"); await tick();
	await render(<View cwd="/other" />);
	expect(document.querySelector("output")?.dataset.state).toBe("idle");
	await render(<View />);
	expect(document.querySelector("output")?.textContent).toBe("|");
});

it("查询失败和断连显示错误，不被当作空结果，恢复后重新查询", async () => {
	query.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce(page("retry", true));
	await render(<View />);
	await click("中文"); await tick();
	expect(document.querySelector("output")?.dataset.state).toBe("error");
	expect(document.body.textContent).toContain("读取失败");
	await render(<View connected={false} />);
	expect(document.body.textContent).toContain("连接已断开");
	await render(<View />); await tick();
	expect(document.querySelector("output")?.dataset.state).toBe("done");
});
