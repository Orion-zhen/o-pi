import { act } from "react";
import { expect, it, vi } from "vitest";
import type { ModelServiceCatalog } from "../../src/gui/model-services.ts";
import { useServiceCatalog, type CatalogQuery } from "../../src/gui/ui/model-services/use-service-catalog.ts";
import { deferred } from "../helpers/async.ts";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
const catalog = (id: string, reloadRequired = false): ModelServiceCatalog => ({ candidates: [{ id }], reloadRequired, error: "" });
function View({ sessionId = "first", content = "saved", query, receive = () => {} }: {
	sessionId?: string; content?: string; query: CatalogQuery; receive?: (value: ModelServiceCatalog) => void;
}) {
	const state = useServiceCatalog("local", sessionId, content, query, receive);
	return <><output>{state.value?.candidates.map(({ id }) => id).join(",")}</output><span>{state.value?.reloadRequired ? "待重载" : ""}</span>
		<button disabled={state.loading} onClick={state.retry}>重试</button><p role="alert">{state.error}</p></>;
}

it("自动获取候选，切换会话丢弃旧响应，保存后重新查询", async () => {
	const previous = deferred<ModelServiceCatalog>();
	const receive = vi.fn();
	const query = vi.fn<CatalogQuery>().mockReturnValueOnce(previous.promise).mockResolvedValue(catalog("current"));
	await render(<View query={query} receive={receive} />);
	await render(<View sessionId="second" query={query} receive={receive} />);
	await act(async () => { previous.resolve(catalog("previous")); });
	expect(document.querySelector("output")?.textContent).toBe("current");
	expect(receive).toHaveBeenCalledExactlyOnceWith(catalog("current"));
	const saved = deferred<ModelServiceCatalog>();
	query.mockReturnValueOnce(saved.promise);
	await render(<View sessionId="second" content="new saved content" query={query} />);
	expect(document.querySelector("output")?.textContent).toBe("current");
	await act(async () => { saved.resolve(catalog("current,next", true)); });
	expect(document.querySelector("output")?.textContent).toBe("current,next");
	expect(document.body.textContent).toContain("待重载");
	expect(query).toHaveBeenLastCalledWith({ query: "modelServiceCatalog", provider: "local" });
});

it("切换会话时清除上一会话的候选，避免沿用其他连接的列表", async () => {
	const pending = deferred<ModelServiceCatalog>();
	const query = vi.fn<CatalogQuery>().mockResolvedValueOnce(catalog("first")).mockReturnValueOnce(pending.promise);
	await render(<View query={query} />);
	expect(document.querySelector("output")?.textContent).toBe("first");
	await render(<View sessionId="second" query={query} />);
	expect(document.querySelector("output")?.textContent).toBe("");
	await act(async () => { pending.resolve(catalog("second")); });
	expect(document.querySelector("output")?.textContent).toBe("second");
});

it("候选获取失败后可重试，不执行会话刷新动作", async () => {
	const query = vi.fn<CatalogQuery>().mockRejectedValueOnce(new Error("network failed")).mockResolvedValue(catalog("remote"));
	await render(<View query={query} />);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("获取候选模型失败");
	await act(async () => { document.querySelector("button")?.click(); });
	expect(document.querySelector("output")?.textContent).toBe("remote");
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
	expect(query).toHaveBeenCalledTimes(2);
});

it("关闭设置后丢弃候选响应", async () => {
	const pending = deferred<ModelServiceCatalog>();
	const query = vi.fn<CatalogQuery>().mockReturnValue(pending.promise);
	await render(<View query={query} />);
	await render(null);
	await act(async () => { pending.resolve(catalog("remote")); });
	expect(query).toHaveBeenCalledOnce();
	expect(document.body.textContent).toBe("");
});
