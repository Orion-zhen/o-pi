import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Query } from "../../../../../../src/gui/shared/protocol/queries.ts";
import { useComposerQueries } from "../../../../../../src/gui/frontend/features/chat/composer/use-composer-queries.ts";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";

const render = useReactFixture(() => vi.useRealTimers());
const query = vi.fn<Query>();
const send = vi.fn(async () => {});
beforeEach(() => { vi.useFakeTimers(); query.mockReset(); send.mockClear(); });

function View({ draft }: { draft: string }) {
	const value = useComposerQueries({ draft, connected: true, query: query as Query, send });
	return <>
		<button onClick={() => void value.completeFiles(draft.slice(1))}>补全文件</button>
		<output>{value.fileChoices.join(",")}</output><p role="alert">{value.error}</p>
	</>;
}
async function complete() {
	const button = document.querySelector("button");
	if (!button) throw new Error("缺少补全操作");
	await act(async () => button.click());
}

it("修改文件前缀后只显示最新候选，旧失败不能覆盖新结果", async () => {
	const first = Promise.withResolvers<string[]>();
	query.mockReturnValueOnce(first.promise).mockResolvedValueOnce(["second.ts"]);
	await render(<View draft="@first" />); await complete();
	await render(<View draft="@second" />); await complete();
	await act(async () => first.reject(new Error("过时的读取失败")));
	expect(document.querySelector("output")?.textContent).toBe("second.ts");
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
});

it("切换会话重新挂载后，同一前缀不会混入旧会话候选", async () => {
	const result = Promise.withResolvers<string[]>();
	query.mockReturnValueOnce(result.promise).mockResolvedValueOnce(["current.ts"]);
	await render(<View key="one" draft="@file" />); await complete();
	await render(<View key="two" draft="@file" />); await complete();
	await act(async () => result.resolve(["old.ts"]));
	expect(document.querySelector("output")?.textContent).toBe("current.ts");
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
});
