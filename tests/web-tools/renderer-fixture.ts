import { expect } from "vitest";

export const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

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
