import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageEntry, StorageGroup } from "../../src/gui/storage.ts";
import { StorageGroupView } from "../../src/gui/ui/storage/storage-group.tsx";

let root: ReturnType<typeof createRoot>;
const requestRemoval = vi.fn();
const entry = (name: string, bytes: number): StorageEntry => ({
	id: name, name, path: `/storage/${name}`, bytes, files: null, modified: 0, blocked: null,
});
const group = (entries: StorageEntry[], id: StorageGroup["id"] = "sessions"): StorageGroup => ({
	id, title: id, paths: ["/storage"], entries, error: null,
});
async function render(groups: StorageGroup[]) {
	await act(async () => root.render(groups.map((group) => createElement(StorageGroupView, {
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

beforeEach(() => {
	const { window, document } = parseHTML("<html><body></body></html>");
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", document);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
	root = createRoot(document.body);
	requestRemoval.mockClear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

describe("存储分类按文件大小排序", () => {
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
