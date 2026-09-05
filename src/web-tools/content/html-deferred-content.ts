import type { WebFetchAnalysisSummary } from "../core/types.js";

type DeferredFragmentKind = "template_for" | "shadow_root" | "noscript";

const MAX_DEFERRED_FRAGMENTS = 64;
const MAX_DEFERRED_DEPTH = 8;
const DECLARATION_SELECTOR = "template[for], template[shadowrootmode], noscript";
const TOP_LEVEL_SCAN_SELECTOR = `[id], ${DECLARATION_SELECTOR}`;

export interface ExtractedDeferredContent {
	evidence: WebFetchAnalysisSummary["deferredFragments"];
	fragments: DocumentFragment[];
}

interface DeferredContext {
	document: Document;
	topLevelTargets: Map<string, Element[]>;
	claimedTargets: Set<string>;
	removedBaseNodes: Set<Element>;
	discovered: number;
	resolved: number;
	processed: number;
	limited: boolean;
}

/**
 * 展开声明式内容，并从基础文档移除声明和被替换目标；只保留分页和完整性所需计数。
 */
export function extractDeferredContent(document: Document): ExtractedDeferredContent {
	const scanned = [...document.querySelectorAll(TOP_LEVEL_SCAN_SELECTOR)];
	const context: DeferredContext = {
		document,
		topLevelTargets: indexExactIds(scanned),
		claimedTargets: new Set<string>(),
		removedBaseNodes: new Set<Element>(),
		discovered: 0,
		resolved: 0,
		processed: 0,
		limited: false,
	};
	const fragments: DocumentFragment[] = [];
	const declarations = documentDeclarations(document, scanned);
	for (const declaration of declarations) context.removedBaseNodes.add(declaration);
	for (const declaration of declarations) {
		const kind = declarationKind(declaration);
		if (!beginDeclaration(context)) continue;
		if (kind === undefined) continue;
		const fragment = extractTopLevelDeclaration(declaration, kind, context);
		if (fragment !== undefined) fragments.push(fragment);
	}
	for (const removed of context.removedBaseNodes) removed.remove();
	return {
		evidence: {
			discovered: context.discovered,
			resolved: context.resolved,
			limited: context.limited,
		},
		fragments,
	};
}

function extractTopLevelDeclaration(
	declaration: Element,
	kind: DeferredFragmentKind,
	context: DeferredContext,
): DocumentFragment | undefined {
	if (kind === "template_for") {
		const targetId = declaration.getAttribute("for")?.trim();
		if (targetId === undefined || targetId.length === 0) return undefined;
		if (context.claimedTargets.has(targetId)) return undefined;
		const targets = context.topLevelTargets.get(targetId) ?? [];
		if (targets.length === 0 || targets.length !== 1) return undefined;
		const target = targets[0];
		if (
			target === undefined
			|| target.parentNode === null
			|| target === context.document.documentElement
			|| target === context.document.head
			|| target === context.document.body
			|| target.contains(declaration)
		) return undefined;
		context.claimedTargets.add(targetId);
		context.removedBaseNodes.add(target);
		const fragment = cloneTemplateContent(declaration);
		expandNestedDeclarations(fragment, 1, context, new Set<string>());
		recordResolved(context);
		return fragment;
	}
	if (kind === "shadow_root") {
		if (!hasValidShadowMode(declaration)) return undefined;
		const fragment = cloneTemplateContent(declaration);
		expandNestedDeclarations(fragment, 1, context, new Set<string>());
		recordResolved(context);
		return fragment;
	}
	const fragment = cloneNoscriptContent(declaration, context.document);
	expandNestedDeclarations(fragment, 1, context, new Set<string>());
	recordResolved(context);
	return fragment;
}

function expandNestedDeclarations(
	root: DocumentFragment,
	depth: number,
	context: DeferredContext,
	claimedTargets: Set<string>,
): void {
	for (const declaration of topLevelDeclarations(root)) {
		const kind = declarationKind(declaration);
		if (!beginDeclaration(context)) {
			declaration.remove();
			continue;
		}
		if (kind === undefined) {
			declaration.remove();
			continue;
		}
		if (depth >= MAX_DEFERRED_DEPTH) {
			context.limited = true;
			declaration.remove();
			continue;
		}
		if (kind === "template_for") {
			expandNestedLinkedTemplate(root, declaration, depth, context, claimedTargets);
			continue;
		}
		if (kind === "shadow_root") {
			if (!hasValidShadowMode(declaration)) {
				declaration.remove();
				continue;
			}
			const fragment = cloneTemplateContent(declaration);
			expandNestedDeclarations(fragment, depth + 1, context, new Set<string>());
			declaration.replaceWith(fragment);
			recordResolved(context);
			continue;
		}
		const fragment = cloneNoscriptContent(declaration, context.document);
		expandNestedDeclarations(fragment, depth + 1, context, claimedTargets);
		declaration.replaceWith(fragment);
		recordResolved(context);
	}
}

function expandNestedLinkedTemplate(
	root: DocumentFragment,
	declaration: Element,
	depth: number,
	context: DeferredContext,
	claimedTargets: Set<string>,
): void {
	const targetId = declaration.getAttribute("for")?.trim();
	if (targetId === undefined || targetId.length === 0) {
		declaration.remove();
		return;
	}
	if (claimedTargets.has(targetId)) {
		declaration.remove();
		return;
	}
	const targets = exactIdMatches(root, targetId);
	if (targets.length === 0 || targets.length !== 1) {
		declaration.remove();
		return;
	}
	const target = targets[0];
	if (target === undefined || target.parentNode === null || target.contains(declaration)) {
		declaration.remove();
		return;
	}
	claimedTargets.add(targetId);
	const fragment = cloneTemplateContent(declaration);
	expandNestedDeclarations(fragment, depth + 1, context, new Set<string>());
	target.replaceWith(fragment);
	declaration.remove();
	recordResolved(context);
}

function beginDeclaration(context: DeferredContext): boolean {
	context.discovered += 1;
	if (context.processed < MAX_DEFERRED_FRAGMENTS) {
		context.processed += 1;
		return true;
	}
	context.limited = true;
	return false;
}

function recordResolved(context: DeferredContext): void {
	context.resolved += 1;
}

function declarationKind(declaration: Element): DeferredFragmentKind | undefined {
	if (declaration.localName === "noscript") return "noscript";
	const hasFor = declaration.hasAttribute("for");
	const hasShadow = declaration.hasAttribute("shadowrootmode");
	if (hasFor === hasShadow) return undefined;
	return hasFor ? "template_for" : "shadow_root";
}

function hasValidShadowMode(declaration: Element): boolean {
	const mode = declaration.getAttribute("shadowrootmode")?.trim().toLowerCase();
	return mode === "open" || mode === "closed";
}

function cloneTemplateContent(declaration: Element): DocumentFragment {
	return (declaration as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment;
}

function cloneNoscriptContent(declaration: Element, document: Document): DocumentFragment {
	const template = document.createElement("template");
	template.innerHTML = declaration.innerHTML;
	return template.content.cloneNode(true) as DocumentFragment;
}

function topLevelDeclarations(root: ParentNode): Element[] {
	return topLevelDeclarationsFrom([...root.querySelectorAll(DECLARATION_SELECTOR)]);
}

function topLevelDeclarationsFrom(declarations: Element[]): Element[] {
	const declarationSet = new Set(declarations);
	return declarations.filter((declaration) => {
		let parent = declaration.parentElement;
		while (parent !== null) {
			if (declarationSet.has(parent)) return false;
			parent = parent.parentElement;
		}
		return true;
	});
}

function documentDeclarations(document: Document, scanned: Element[]): Element[] {
	return topLevelDeclarationsFrom(scanned.filter((element) =>
		element.localName === "noscript"
		|| element.localName === "template" && (element.hasAttribute("for") || element.hasAttribute("shadowrootmode"))
	)).filter((declaration) => declaration.localName !== "noscript" || document.body.contains(declaration));
}

function indexExactIds(scanned: readonly Element[]): Map<string, Element[]> {
	const indexed = new Map<string, Element[]>();
	for (const candidate of scanned) {
		const id = candidate.getAttribute("id");
		if (id === null) continue;
		const existing = indexed.get(id);
		if (existing === undefined) indexed.set(id, [candidate]);
		else existing.push(candidate);
	}
	return indexed;
}

function exactIdMatches(root: ParentNode, targetId: string): Element[] {
	return [...root.querySelectorAll("[id]")].filter((candidate) => candidate.getAttribute("id") === targetId);
}
