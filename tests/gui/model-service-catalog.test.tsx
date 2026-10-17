import { act } from "react";
import { expect, it, vi } from "vitest";
import type { ModelServiceCatalog } from "../../src/gui/model-services.ts";
import type { Send } from "../../src/gui/ui/runtime/connection.ts";
import { useServiceCatalog, type CatalogQuery } from "../../src/gui/ui/model-services/use-service-catalog.ts";
import { deferred } from "../helpers/async.ts";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
const catalog = (auth: string, reloadRequired = false): ModelServiceCatalog => ({ auth, models: [], reloadRequired, canRefresh: !reloadRequired });
function View({ sessionId = "first", content = "saved", query, send }: { sessionId?: string; content?: string; query: CatalogQuery; send: Send }) {
	const state = useServiceCatalog("local", sessionId, content, query, send);
	return <><output>{state.value?.auth}</output><span>{state.value?.reloadRequired ? "待重载" : ""}</span>
		<button disabled={state.status === "refreshing" || !state.value?.canRefresh} onClick={state.refresh}>刷新</button>
		<p role="status">{state.status === "refreshed" ? "模型已刷新" : ""}</p><p role="alert">{state.error}</p></>;
}
async function refresh() {
	await act(async () => { document.querySelector("button")?.click(); });
}

it("切换会话后丢弃旧目录响应，保存成功后重新查询加载状态", async () => {
	const previous = deferred<ModelServiceCatalog>();
	const query = vi.fn<CatalogQuery>().mockReturnValueOnce(previous.promise).mockResolvedValue(catalog("当前会话"));
	const send = vi.fn<Send>().mockResolvedValue(true);
	await render(<View query={query} send={send} />);
	await render(<View sessionId="second" query={query} send={send} />);
	await act(async () => { previous.resolve(catalog("旧会话")); });
	expect(document.querySelector("output")?.textContent).toBe("当前会话");
	query.mockResolvedValue(catalog("当前会话", true));
	await render(<View sessionId="second" content="new saved content" query={query} send={send} />);
	expect(document.body.textContent).toContain("待重载");
});

it("刷新成功后直接读取目录，失败时保留目录并允许重试", async () => {
	const query = vi.fn<CatalogQuery>().mockResolvedValue(catalog("原目录"));
	const send = vi.fn<Send>().mockResolvedValue(false);
	await render(<View query={query} send={send} />);
	await refresh();
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("模型列表刷新失败");
	expect(document.querySelector("output")?.textContent).toBe("原目录");
	send.mockResolvedValue(true);
	query.mockResolvedValue(catalog("新目录"));
	await refresh();
	expect(send).toHaveBeenLastCalledWith({ action: "refreshModelService", provider: "local" });
	expect(document.querySelector("output")?.textContent).toBe("新目录");
	expect(document.querySelector('[role="status"]')?.textContent).toBe("模型已刷新");
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
});

it("切换会话和关闭设置后，旧刷新完成不会再次查询或覆盖状态", async () => {
	const pending = deferred<boolean>();
	const query = vi.fn<CatalogQuery>().mockResolvedValue(catalog("当前目录"));
	const send = vi.fn<Send>().mockReturnValue(pending.promise);
	await render(<View query={query} send={send} />);
	await refresh();
	await render(<View sessionId="second" query={query} send={send} />);
	await act(async () => { pending.resolve(true); });
	expect(query).toHaveBeenCalledTimes(2);
	expect(document.querySelector('[role="status"]')?.textContent).toBe("");
	const unmounted = deferred<boolean>();
	send.mockReturnValue(unmounted.promise);
	await refresh();
	await render(null);
	await act(async () => { unmounted.resolve(true); });
	expect(query).toHaveBeenCalledTimes(2);
});
