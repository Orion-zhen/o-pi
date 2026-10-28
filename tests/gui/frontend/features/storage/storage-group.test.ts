import { act, createElement } from "react";
import { useReactFixture } from "../../../helpers/react-fixture.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageEntry, StorageGroup } from "../../../../../src/gui/shared/storage.ts";
let TooltipProvider: typeof import("../../../../../src/gui/frontend/ui/tooltip.tsx")["TooltipProvider"];
let StorageGroupView: typeof import("../../../../../src/gui/frontend/features/storage/storage-group.tsx")["StorageGroupView"];

const renderRoot = useReactFixture();
const requestRemoval = vi.fn();
const entry = (name: string, bytes: number): StorageEntry => ({
	id: name, name, path: `/storage/${name}`, bytes, files: null, modified: 0, blocked: null,
});
const group = (entries: StorageEntry[], id: StorageGroup["id"] = "sessions"): StorageGroup => ({
	id, title: id, paths: ["/storage"], entries, error: null,
});
async function render(groups: StorageGroup[]) {
	await renderRoot(createElement(TooltipProvider, null, groups.map((group) => createElement(StorageGroupView, {
		key: group.id, group, disabled: false, requestRemoval,
	}))));
}
function section(title = "sessions"): HTMLElement {
	const element = document.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
	if (!element) throw new Error(`缺少分类：${title}`);
	return element;
}
function button(name: string, container = section()): HTMLButtonElement {
	const element = [...container.querySelectorAll("button")].find((button) => button.textContent === name);
	if (!element) throw new Error(`缺少按钮：${name}`);
	return element;
}
async function click(element: HTMLElement) {
	await act(async () => element.click());
}
async function expand(container = section()) {
	const heading = container.querySelector<HTMLButtonElement>(".storage-group-heading");
	if (!heading) throw new Error("缺少分类标题");
	await click(heading);
}
const names = (container = section()) => [...container.querySelectorAll(".storage-entry:not([aria-hidden=true]) strong")].map((element) => element.textContent);

beforeEach(async () => {
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	({ TooltipProvider } = await import("../../../../../src/gui/frontend/ui/tooltip.tsx"));
	({ StorageGroupView } = await import("../../../../../src/gui/frontend/features/storage/storage-group.tsx"));
	requestRemoval.mockClear();
});

describe("存储分类选择与排序", () => {
	it("选择条目后分组半选，点击分组全选并提交删除，再点击取消全选", async () => {
		const entries = [entry("甲", 10), entry("乙", 20)];
		await render([group(entries)]);
		await expand();
		const checkboxes = [...section().querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
		const [all, first] = checkboxes;
		if (!all || !first) throw new Error("缺少存储选择框");
		await click(first);
		expect(all.getAttribute("aria-checked")).toBe("mixed");
		const svg = all.querySelector("svg");
		expect(svg).not.toBeNull();
		await click(all);
		expect(checkboxes.map((checkbox) => checkbox.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
		expect(all.querySelector("svg")).toBe(svg);
		await click(button("删除所选 (2)"));
		expect(requestRemoval.mock.calls[0]?.[0]).toEqual(entries);
		await click(all);
		expect(checkboxes.map((checkbox) => checkbox.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
		expect(all.querySelector("svg")).toBeNull();
		expect(button("删除所选").disabled).toBe(true);
	});

	it("循环切换默认、降序、升序，同大小保持原序，各分类独立", async () => {
		const entries = [entry("中", 20), entry("小", 0), entry("大甲", 100), entry("大乙", 100)];
		await render([group(entries), group(entries, "desktop")]);
		await expand();
		await expand(section("desktop"));
		expect(names()).toEqual(["中", "小", "大甲", "大乙"]);
		await click(button("文件大小：不排序"));
		expect(names()).toEqual(["大甲", "大乙", "中", "小"]);
		expect(names(section("desktop"))).toEqual(["中", "小", "大甲", "大乙"]);
		await click(button("文件大小：降序"));
		expect(names()).toEqual(["小", "中", "大甲", "大乙"]);
		await click(button("文件大小：升序"));
		expect(names()).toEqual(["中", "小", "大甲", "大乙"]);
		expect(entries.map((entry) => entry.name)).toEqual(["中", "小", "大甲", "大乙"]);
	});

	it("对完整列表排序后分页，切换回第一页且保留所选条目", async () => {
		const entries = Array.from({ length: 32 }, (_, index) => entry(`文件${index}`, index));
		await render([group(entries)]);
		await expand();
		await click(button("下一页"));
		expect(names()).toEqual(["文件30", "文件31"]);
		const selected = section().querySelector<HTMLButtonElement>('[aria-label="选择 文件30"]');
		if (!selected) throw new Error("缺少条目复选框");
		await click(selected);
		await click(button("文件大小：不排序"));
		expect(names()).toHaveLength(30);
		expect(names()[0]).toBe("文件31");
		expect(names().at(-1)).toBe("文件2");
		expect(button("上一页").disabled).toBe(true);
		expect(section().querySelector('[aria-label="选择 文件30"]')?.getAttribute("aria-checked")).toBe("true");
		await click(button("删除所选 (1)"));
		expect(requestRemoval.mock.calls[0]?.[0]).toEqual([entries[30]]);
	});
});
