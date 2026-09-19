import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DisclosureMemoryContext, type DisclosureMemory } from "../../src/gui/ui/disclosure-memory.ts";

export function renderWithMemory(element: ReactNode, memory: DisclosureMemory = new Map()): string {
	return renderToStaticMarkup(createElement(DisclosureMemoryContext, { value: memory }, element));
}
