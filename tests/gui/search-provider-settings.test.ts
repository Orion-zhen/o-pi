import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { moduleConfigOptions } from "../../src/gui/host/module-config-options.ts";
import { SearchProviderSettings } from "../../src/gui/ui/settings/search-provider-settings.tsx";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";

function render(order: unknown, auxiliary: unknown = []) {
	const schema = { properties: { websearch: { properties: { primary_providers: { type: "array", items: { oneOf: [
		{ const: "index_a", title: "自定义索引 A" }, { const: "index_b", title: "自定义索引 B" },
	] } } } } } };
	const metadata = moduleConfigOptions(schema);
	const values: Record<string, unknown> = {
		"websearch.primary_providers": order, "websearch.auxiliary_providers": auxiliary, "websearch.index_a.enabled": true, "websearch.index_b.enabled": false,
	};
	const content = createElement(SearchProviderSettings, {
		path: "websearch.primary_providers", choices: metadata.arrayOptions["websearch.primary_providers"],
		valueAt: (path) => values[path], defaultAt: (path) => path === "websearch.primary_providers" ? ["index_a", "index_b"] : true,
		change() {}, changeGroups() {}, disabled: false, renderDetails: (prefix) => createElement("input", { "aria-label": `${prefix} detail` }),
	});
	return parseHTML(renderToStaticMarkup(createElement(TooltipProvider, null, content))).document;
}

it("引擎标识、名称和数量来自 schema，显示顺序与启停来自配置", () => {
	const document = render(["index_b", "index_a"]);
	expect([...document.querySelectorAll(".search-provider-name")].map((label) => label.textContent)).toEqual(["自定义索引 B", "自定义索引 A"]);
	expect([...document.querySelectorAll('[role="switch"]')].map((control) => control.getAttribute("aria-checked"))).toEqual(["false", "true"]);
	expect(document.querySelector('[aria-label="上移 自定义索引 B"]')?.hasAttribute("disabled")).toBe(true);
	expect(document.querySelector('[aria-label="下移 自定义索引 A"]')?.hasAttribute("disabled")).toBe(true);
});

it("列表内不显示说明栏或顺序重置按钮", () => {
	const document = render(["index_a", "index_b"]);
	expect(document.querySelectorAll(".search-provider-heading")).toHaveLength(2);
	expect(document.querySelector(".settings-description")).toBeNull();
	const changed = render(["index_b", "index_a"]);
	expect(changed.querySelector('[aria-label="重置搜索引擎顺序"]')).toBeNull();
	expect(changed.querySelector(".settings-description")).toBeNull();
});

it("展开按钮位于开关右侧，名称也可展开，详情初始不挂载", () => {
	const document = render(["index_a", "index_b"]);
	const row = document.querySelector("li");
	expect(row?.querySelector('.search-provider-name')?.getAttribute("aria-expanded")).toBe("false");
	const actions = row?.querySelector(".search-provider-actions");
	expect(actions?.lastElementChild?.getAttribute("aria-label")).toBe("展开 自定义索引 A");
	expect([...actions?.querySelectorAll("button") ?? []].map((button) => button.getAttribute("aria-label"))).toEqual([
		"设为辅助引擎 自定义索引 A", "上移 自定义索引 A", "下移 自定义索引 A", "自定义索引 A", "展开 自定义索引 A",
	]);
	expect(document.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(0);
});

it("分组可为空，主辅分组分别显示且不能重复分配引擎", () => {
	const document = render(["index_a"], ["index_b"]);
	expect(document.querySelector('[aria-label="主搜索引擎顺序"] .search-provider-name')?.textContent).toBe("自定义索引 A");
	expect(document.querySelector('[aria-label="辅助搜索引擎顺序"] .search-provider-name')?.textContent).toBe("自定义索引 B");
	expect(document.querySelector('[aria-label="设为辅助引擎 自定义索引 A"]')?.textContent).toBe("设为辅助引擎");
	expect(document.querySelector('[aria-label="设为主引擎 自定义索引 B"]')?.textContent).toBe("设为主引擎");
	expect(render([], ["index_a", "index_b"]).querySelector('[role="alert"]')).toBeNull();
	expect(render(["index_a", "index_b"], ["index_a"]).querySelector('[role="alert"]')).not.toBeNull();
});

it.each([
	{ order: ["index_a", "index_a"] }, { order: ["index_a"] }, { order: ["index_a", "unknown"] },
])("非法顺序 $order 提示修复，不静默替换为默认顺序", ({ order }) => {
	const document = render(order);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("搜索引擎分组无效");
	expect(document.querySelectorAll("li")).toHaveLength(0);
});
