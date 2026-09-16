import { expect, type Locator } from "@playwright/test";

export async function expectContinuousWrappedText(line: Locator) {
	const flow = await line.evaluate((element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const rectangles: { left: number; right: number; top: number }[] = [];
		while (walker.nextNode()) {
			const node = walker.currentNode;
			if (node.parentElement?.closest(".linenumber")) continue;
			for (let offset = 0; offset < (node.textContent?.length ?? 0); offset++) {
				if (/\s/.test(node.textContent?.[offset] ?? "")) continue;
				const range = document.createRange();
				range.setStart(node, offset);
				range.setEnd(node, offset + 1);
				const rect = range.getBoundingClientRect();
				if (rect.width) rectangles.push({ left: rect.left, right: rect.right, top: rect.top });
			}
		}
		let wraps = 0;
		let outOfOrder = 0;
		for (let index = 1; index < rectangles.length; index++) {
			const previous = rectangles[index - 1];
			const current = rectangles[index];
			if (!previous || !current) continue;
			if (current.top > previous.top + 2) wraps++;
			if (current.top < previous.top - 2 || (Math.abs(current.top - previous.top) <= 2 && current.left < previous.right - 2)) outOfOrder++;
		}
		return { wraps, outOfOrder };
	});
	expect(flow.wraps).toBeGreaterThan(0);
	expect(flow.outOfOrder).toBe(0);
}
