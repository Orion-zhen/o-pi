import { parseHTML } from "linkedom";
import type { WebFetchFailureDetails } from "../core/types.ts";

const HEADINGS = "h1, h2, h3, h4, h5, h6";
const INACTIVE = 'head, script, style, template, noscript, [hidden], [aria-hidden="true"]';

/** 按真实锚点缩小静态 DOM，不生成标题 slug，也不保留整页副本。 */
export function selectHtmlAnchor(document: Document, fragment: string): { document: Document; anchor: string } | WebFetchFailureDetails {
	let anchor: string;
	try {
		anchor = decodeURIComponent(fragment.slice(1));
	} catch {
		return missingAnchor();
	}
	const target = document.getElementById(anchor)
		?? [...document.querySelectorAll("a[name]")].find((element) => element.getAttribute("name") === anchor);
	if (target === undefined || target.closest(INACTIVE) !== null) return missingAnchor();

	const heading = target.closest(HEADINGS) ?? adjacentHeading(target);
	const titleHeading = heading ?? target.querySelector(HEADINGS);
	const title = titleHeading?.textContent?.replace(/\s+/gu, " ").trim();
	const base = document.querySelector("base[href]");
	// 声明可能位于章节外，但只带入明确指向选区内目标的 template。
	const declarations = [...document.querySelectorAll("template[for]")];
	const root = heading === null ? target : headingSection(heading, document);
	const ids = new Set([root.id, ...[...root.querySelectorAll("[id]")].map((element) => element.id)].filter(Boolean));
	const linked = declarations.filter((element) => !root.contains(element) && ids.has(element.getAttribute("for")?.trim() ?? ""));
	const scoped = parseHTML("<html><head></head><body></body></html>").document;
	if (base !== null) scoped.head.append(base);
	if (title) {
		const element = scoped.createElement("title");
		element.textContent = title;
		scoped.head.append(element);
	}
	scoped.body.append(root, ...linked);
	return { document: scoped, anchor };
}

function adjacentHeading(target: Element): Element | null {
	if (target.localName !== "a" || target.textContent?.trim()) return null;
	const next = target.nextElementSibling;
	return next?.matches(HEADINGS) ? next : null;
}

function headingSection(heading: Element, document: Document): Element {
	const root = heading.closest('main, article, [role="main"]')
		?? (document.body.contains(heading) ? document.body : document.documentElement);
	const headings = [...root.querySelectorAll(HEADINGS)].filter((element) => element.closest(INACTIVE) === null);
	const level = headingLevel(heading);
	const end = headings.slice(headings.indexOf(heading) + 1).find((element) => headingLevel(element) <= level);
	// 逐层删除范围外的兄弟节点，保留跨容器章节内的原有结构。
	for (let node: Node = heading; node !== root && node.parentNode !== null; node = node.parentNode) {
		while (node.previousSibling !== null) node.parentNode.removeChild(node.previousSibling);
	}
	if (end !== undefined) {
		for (let node: Node = end; node !== root && node.parentNode !== null; node = node.parentNode) {
			while (node.nextSibling !== null) node.parentNode.removeChild(node.nextSibling);
		}
		end.remove();
	}
	return root;
}

function headingLevel(heading: Element): number {
	return Number(heading.localName.slice(1));
}

function missingAnchor(): WebFetchFailureDetails {
	return { status: "failed", error: { code: "ANCHOR_NOT_FOUND", message: "No static anchor target. Retry without the fragment to read the page." } };
}
