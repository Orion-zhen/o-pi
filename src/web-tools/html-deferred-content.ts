import type {
	DeferredEvidence,
	DeferredFragmentKind,
	DeferredFragmentReason,
	DeferredFragmentStatus,
} from "./html-page-analyzer.js";

const MAX_DEFERRED_FRAGMENTS = 64;
const MAX_DEFERRED_DEPTH = 8;
const DEFERRED_MARKER_ATTRIBUTE = "data-pi-webfetch-deferred";
const DECLARATION_SELECTOR = "template[for], template[shadowrootmode], noscript";

export interface ExtractedDeferredContent {
	evidence: DeferredEvidence;
	fragments: string[];
}

interface DeferredContext {
	document: Document;
	claimedTargets: Set<string>;
	markedBaseNodes: Set<Element>;
	discovered: number;
	resolved: number;
	skipped: number;
	processed: number;
	limited: boolean;
	limitRecorded: boolean;
	results: DeferredEvidence["fragments"];
}

/**
 * Extract declarative content without mixing it into the base body candidate.
 * The base clone is marked only at declarations and successfully replaced targets.
 */
export function extractDeferredContent(document: Document, baseDocument: Document): ExtractedDeferredContent {
	const context: DeferredContext = {
		document,
		claimedTargets: new Set<string>(),
		markedBaseNodes: new Set<Element>(),
		discovered: 0,
		resolved: 0,
		skipped: 0,
		processed: 0,
		limited: false,
		limitRecorded: false,
		results: [],
	};
	const fragments: string[] = [];
	const declarations = documentDeclarations(document);
	const baseDeclarations = documentDeclarations(baseDocument);
	for (let index = 0; index < baseDeclarations.length; index += 1) {
		const declaration = baseDeclarations[index];
		if (declaration === undefined) continue;
		declaration.setAttribute(DEFERRED_MARKER_ATTRIBUTE, "");
		context.markedBaseNodes.add(declaration);
	}
	for (const declaration of declarations) {
		const kind = declarationKind(declaration);
		if (!beginDeclaration(context, kind)) continue;
		if (kind === undefined) {
			recordSkipped(context, "template_for", "invalid_declaration");
			continue;
		}
		const fragment = extractTopLevelDeclaration(declaration, kind, baseDocument, context);
		if (fragment === undefined) continue;
		fragments.push(serializeFragment(fragment, document));
	}
	for (const marked of context.markedBaseNodes) marked.remove();
	return {
		evidence: {
			discovered: context.discovered,
			resolved: context.resolved,
			skipped: context.skipped,
			limited: context.limited,
			fragments: context.results,
		},
		fragments,
	};
}

function extractTopLevelDeclaration(
	declaration: Element,
	kind: DeferredFragmentKind,
	baseDocument: Document,
	context: DeferredContext,
): DocumentFragment | undefined {
	if (kind === "template_for") {
		const targetId = declaration.getAttribute("for")?.trim();
		if (targetId === undefined || targetId.length === 0) {
			recordSkipped(context, kind, "invalid_declaration");
			return undefined;
		}
		if (context.claimedTargets.has(targetId)) {
			recordSkipped(context, kind, "duplicate_target");
			return undefined;
		}
		const targets = exactIdMatches(context.document, targetId);
		if (targets.length === 0) {
			recordSkipped(context, kind, "missing_target");
			return undefined;
		}
		if (targets.length !== 1) {
			recordSkipped(context, kind, "ambiguous_target");
			return undefined;
		}
		const target = targets[0];
		if (
			target === undefined
			|| target.parentNode === null
			|| target === context.document.documentElement
			|| target === context.document.head
			|| target === context.document.body
			|| target.contains(declaration)
		) {
			recordSkipped(context, kind, "cyclic_target");
			return undefined;
		}
		context.claimedTargets.add(targetId);
		for (const baseTarget of exactIdMatches(baseDocument, targetId)) {
			baseTarget.setAttribute(DEFERRED_MARKER_ATTRIBUTE, "");
			context.markedBaseNodes.add(baseTarget);
		}
		const fragment = cloneTemplateContent(declaration);
		expandNestedDeclarations(fragment, 1, context, new Set<string>());
		recordResolved(context, kind, "target_replaced");
		return fragment;
	}
	if (kind === "shadow_root") {
		if (!hasValidShadowMode(declaration)) {
			recordSkipped(context, kind, "invalid_declaration");
			return undefined;
		}
		const fragment = cloneTemplateContent(declaration);
		expandNestedDeclarations(fragment, 1, context, new Set<string>());
		recordResolved(context, kind, "shadow_root_expanded");
		return fragment;
	}
	const fragment = cloneNoscriptContent(declaration, context.document);
	expandNestedDeclarations(fragment, 1, context, new Set<string>());
	recordResolved(context, kind, "noscript_expanded");
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
		if (!beginDeclaration(context, kind)) {
			declaration.remove();
			continue;
		}
		if (kind === undefined) {
			recordSkipped(context, "template_for", "invalid_declaration");
			declaration.remove();
			continue;
		}
		if (depth >= MAX_DEFERRED_DEPTH) {
			context.limited = true;
			recordSkipped(context, kind, "depth_limit");
			declaration.remove();
			continue;
		}
		if (kind === "template_for") {
			expandNestedLinkedTemplate(root, declaration, depth, context, claimedTargets);
			continue;
		}
		if (kind === "shadow_root") {
			if (!hasValidShadowMode(declaration)) {
				recordSkipped(context, kind, "invalid_declaration");
				declaration.remove();
				continue;
			}
			const fragment = cloneTemplateContent(declaration);
			expandNestedDeclarations(fragment, depth + 1, context, new Set<string>());
			declaration.replaceWith(fragment);
			recordResolved(context, kind, "shadow_root_expanded");
			continue;
		}
		const fragment = cloneNoscriptContent(declaration, context.document);
		expandNestedDeclarations(fragment, depth + 1, context, claimedTargets);
		declaration.replaceWith(fragment);
		recordResolved(context, kind, "noscript_expanded");
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
		recordSkipped(context, "template_for", "invalid_declaration");
		declaration.remove();
		return;
	}
	if (claimedTargets.has(targetId)) {
		recordSkipped(context, "template_for", "duplicate_target");
		declaration.remove();
		return;
	}
	const targets = exactIdMatches(root, targetId);
	if (targets.length === 0) {
		recordSkipped(context, "template_for", "missing_target");
		declaration.remove();
		return;
	}
	if (targets.length !== 1) {
		recordSkipped(context, "template_for", "ambiguous_target");
		declaration.remove();
		return;
	}
	const target = targets[0];
	if (target === undefined || target.parentNode === null || target.contains(declaration)) {
		recordSkipped(context, "template_for", "cyclic_target");
		declaration.remove();
		return;
	}
	claimedTargets.add(targetId);
	const fragment = cloneTemplateContent(declaration);
	expandNestedDeclarations(fragment, depth + 1, context, new Set<string>());
	target.replaceWith(fragment);
	declaration.remove();
	recordResolved(context, "template_for", "target_replaced");
}

function beginDeclaration(context: DeferredContext, kind: DeferredFragmentKind | undefined): boolean {
	context.discovered += 1;
	if (context.processed < MAX_DEFERRED_FRAGMENTS) {
		context.processed += 1;
		return true;
	}
	context.skipped += 1;
	context.limited = true;
	if (!context.limitRecorded) {
		context.limitRecorded = true;
		context.results.push({
			kind: kind ?? "template_for",
			status: "skipped",
			reason: "fragment_limit",
		});
	}
	return false;
}

function recordResolved(
	context: DeferredContext,
	kind: DeferredFragmentKind,
	reason: DeferredFragmentReason,
): void {
	context.resolved += 1;
	recordResult(context, kind, "resolved", reason);
}

function recordSkipped(
	context: DeferredContext,
	kind: DeferredFragmentKind,
	reason: DeferredFragmentReason,
): void {
	context.skipped += 1;
	recordResult(context, kind, "skipped", reason);
}

function recordResult(
	context: DeferredContext,
	kind: DeferredFragmentKind,
	status: DeferredFragmentStatus,
	reason: DeferredFragmentReason,
): void {
	context.results.push({ kind, status, reason });
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

function serializeFragment(fragment: DocumentFragment, document: Document): string {
	const container = document.createElement("div");
	container.append(fragment);
	return container.innerHTML;
}

function topLevelDeclarations(root: ParentNode): Element[] {
	const declarations = [...root.querySelectorAll(DECLARATION_SELECTOR)];
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

function documentDeclarations(document: Document): Element[] {
	return topLevelDeclarations(document)
		.filter((declaration) => declaration.localName !== "noscript" || document.body.contains(declaration));
}

function exactIdMatches(root: ParentNode, targetId: string): Element[] {
	return [...root.querySelectorAll("[id]")].filter((candidate) => candidate.getAttribute("id") === targetId);
}
