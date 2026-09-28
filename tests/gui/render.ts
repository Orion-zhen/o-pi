import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DisclosureMemoryContext, type DisclosureMemory } from "../../src/gui/ui/disclosure-memory.ts";
import { GuiQueryContext } from "../../src/gui/ui/payload.tsx";
import type { Query } from "../../src/gui/contract.ts";

const query: Query = async () => { throw new Error("静态渲染不应发起载荷查询。"); };

export function renderWithMemory(element: ReactNode, memory: DisclosureMemory = new Map()): string {
	return renderToStaticMarkup(createElement(GuiQueryContext, { value: query },
		createElement(DisclosureMemoryContext, { value: memory }, element)));
}
