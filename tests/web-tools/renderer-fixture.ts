import { expect } from "vitest";

import type { WebFetchSuccessDetails } from "../../src/web-tools/core/types.js";

export const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

export function webFetchDetails(overrides: Partial<WebFetchSuccessDetails> = {}): WebFetchSuccessDetails {
	return {
		status: "success", scope: "static_response", page_kind: "article", text_source: "readability",
		completeness: "partial", omissions: [{ kind: "text_range", reason: "range" }],
		requested_url: "https://example.com/start", final_url: "https://example.com/final", http_status: 200,
		title: "Example article", content_type: "text/html", charset: "utf-8", format: "markdown",
		downloaded_bytes: 100, total_chars: 3000,
		range: { start: 0, end: 1000, total: 3000, has_more: true, next_offset: 1000 },
		authenticated: true, redirect_count: 1, snapshot: "created",
		deferred_fragments: { discovered: 1, resolved: 1, limited: false },
		media: { discovered: 1, returned: 1 }, duration_ms: 12, preview: "preview sentinel",
		...overrides,
	};
}

interface Renderable {
	render(width: number): string[];
}

interface RendererLifecycle<State> {
	createState(): State;
	renderCall(lastComponent: unknown, state: State): Renderable;
	renderProgress(lastComponent: unknown, state: State): Renderable;
	renderSettled(lastComponent: unknown, state: State): Renderable;
	initialContains: readonly string[];
	progressContains: readonly string[];
	settledContains: readonly string[];
}

export function expectRendererLifecycle<State>(fixture: RendererLifecycle<State>): void {
	const state = fixture.createState();
	let call = fixture.renderCall(undefined, state);
	expectContains(render(call), fixture.initialContains);

	call = fixture.renderCall(call, state);
	let result = fixture.renderProgress(undefined, state);
	expect(render(call)).toBe("");
	const progressOutput = render(result);
	expectContains(progressOutput, fixture.progressContains);

	call = fixture.renderCall(call, state);
	result = fixture.renderSettled(result, state);
	expect(render(call)).toBe("");
	const settledOutput = render(result);
	expectContains(settledOutput, fixture.settledContains);
	expect(settledOutput).not.toBe(progressOutput);
}

function render(component: Renderable): string {
	return component.render(160).join("");
}

function expectContains(output: string, values: readonly string[]): void {
	for (const value of values) expect(output).toContain(value);
}
