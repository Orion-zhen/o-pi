import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../../src/gui/frontend/ui/tooltip.tsx";
import { DisclosureMemoryContext, type DisclosureMemory } from "../../../src/gui/frontend/ui/disclosure-memory.ts";
import { GuiQueryContext } from "../../../src/gui/frontend/connection/query-context.ts";
import type { Query } from "../../../src/gui/shared/protocol/queries.ts";

const query: Query = async () => { throw new Error("静态渲染不应发起载荷查询。"); };

export function renderWithMemory(element: ReactNode, memory: DisclosureMemory = new Map()): string {
	return renderToStaticMarkup(createElement(GuiQueryContext, { value: query },
		createElement(TooltipProvider, null, createElement(DisclosureMemoryContext, { value: memory }, element))));
}
