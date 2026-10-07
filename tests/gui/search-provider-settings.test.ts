import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { moduleConfigOptions } from "../../src/gui/host/module-config-options.ts";
import { SearchProviderSettings } from "../../src/gui/ui/settings/search-provider-settings.tsx";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";

function render(order: unknown) {
	const schema = { properties: { websearch: { properties: { provider_order: { type: "array", items: { oneOf: [
		{ const: "index_a", title: "自定义索引 A" }, { const: "index_b", title: "自定义索引 B" },
	] } } } } } };
	const metadata = moduleConfigOptions(schema);
	const values: Record<string, unknown> = {
		"websearch.provider_order": order, "websearch.index_a.enabled": true, "websearch.index_b.enabled": false,
	};
	const content = createElement(SearchProviderSettings, {
		path: "websearch.provider_order", choices: metadata.arrayOptions["websearch.provider_order"],
		valueAt: (path) => values[path], defaultAt: (path) => path === "websearch.provider_order" ? ["index_a", "index_b"] : true,
		change() {}, disabled: false,
	});
	return parseHTML(renderToStaticMarkup(createElement(TooltipProvider, null, content))).document;
}

it("引擎标识、名称和数量来自 schema，显示顺序与启停来自配置", () => {
	const document = render(["index_b", "index_a"]);
	expect([...document.querySelectorAll("li label")].map((label) => label.textContent)).toEqual(["自定义索引 B", "自定义索引 A"]);
	expect([...document.querySelectorAll('[role="switch"]')].map((control) => control.getAttribute("aria-checked"))).toEqual(["false", "true"]);
	expect(document.querySelector('[aria-label="上移 自定义索引 B"]')?.hasAttribute("disabled")).toBe(true);
	expect(document.querySelector('[aria-label="下移 自定义索引 A"]')?.hasAttribute("disabled")).toBe(true);
});

it("列表内不显示说明栏或顺序重置按钮", () => {
	const document = render(["index_a", "index_b"]);
	expect(document.querySelector(".search-provider-heading")).toBeNull();
	expect(document.querySelector(".settings-description")).toBeNull();
	const changed = render(["index_b", "index_a"]);
	expect(changed.querySelector('[aria-label="重置搜索引擎顺序"]')).toBeNull();
	expect(changed.querySelector(".settings-description")).toBeNull();
});

it.each([
	{ order: ["index_a", "index_a"] }, { order: ["index_a"] }, { order: ["index_a", "unknown"] },
])("非法顺序 $order 提示修复，不静默替换为默认顺序", ({ order }) => {
	const document = render(order);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("搜索引擎顺序无效");
	expect(document.querySelectorAll("li")).toHaveLength(0);
});
