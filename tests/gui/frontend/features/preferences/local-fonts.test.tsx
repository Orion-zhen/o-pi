import { act } from "react";
import { expect, it, vi } from "vitest";
import { useLocalFonts } from "../../../../../src/gui/frontend/features/preferences/use-local-fonts.ts";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

const render = useReactFixture(() => { Reflect.deleteProperty(window, "queryLocalFonts"); });
function Fonts() {
	const fonts = useLocalFonts();
	return <><button disabled={!fonts.supported || fonts.loading} onClick={fonts.load}>读取字体</button>
		<output>{fonts.fonts?.join(",")}</output><p role="status">{fonts.error}</p></>;
}

it("字体读取去重、排序并阻止重复请求，失败保留上次字体列表", async () => {
	const first = Promise.withResolvers<{ family: string }[]>();
	const second = Promise.withResolvers<{ family: string }[]>();
	const query = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	Object.assign(window, { queryLocalFonts: query });
	await render(<Fonts />);
	const button = document.querySelector("button");
	if (!button) throw new Error("缺少字体读取按钮");
	await act(async () => { button.click(); button.click(); });
	expect(query).toHaveBeenCalledOnce();
	expect(button.disabled).toBe(true);
	await act(async () => first.resolve([{ family: "Zeta" }, { family: "Alpha" }, { family: "Zeta" }]));
	expect(document.querySelector("output")?.textContent).toBe("Alpha,Zeta");
	await act(async () => button.click());
	await act(async () => second.reject(new DOMException("denied", "NotAllowedError")));
	expect(document.querySelector('[role="status"]')?.textContent).toBe("未获字体访问权限，仍可手写字体名。");
	expect(document.querySelector("output")?.textContent).toBe("Alpha,Zeta");
	expect(button.disabled).toBe(false);
});

it("浏览器没有字体读取能力时不发起请求", async () => {
	await render(<Fonts />);
	expect(document.querySelector("button")?.disabled).toBe(true);
});
