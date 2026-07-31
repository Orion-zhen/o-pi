import { truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import type { BashParams } from "../types.js";

const COLLAPSED_COMMAND_LINES = 5;

interface BashRendererState {
	startedAt?: number | undefined;
	endedAt?: number | undefined;
	interval?: NodeJS.Timeout | undefined;
}

interface BashCallRenderContext {
	expanded: boolean;
	executionStarted: boolean;
	lastComponent: Component | undefined;
	state: BashRendererState;
}

class BashCallComponent implements Component {
	private readonly text = new Text("", 0, 0);
	private content = "";
	private expanded = false;

	update(content: string, expanded: boolean): void {
		this.content = content;
		this.text.setText(content);
		this.expanded = expanded;
	}

	render(width: number): string[] {
		if (this.expanded) return this.text.render(width);
		return truncateToVisualLines(this.content, COLLAPSED_COMMAND_LINES, width).visualLines;
	}

	invalidate(): void {
		this.text.invalidate();
	}
}

/** Render bash commands as a five-line rolling tail until the tool card is expanded. */
export function renderBashCall(
	args: BashParams,
	theme: Pick<Theme, "fg" | "bold">,
	context: BashCallRenderContext,
): Component {
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}

	const component = context.lastComponent instanceof BashCallComponent ? context.lastComponent : new BashCallComponent();
	component.update(formatBashCall(args, theme), context.expanded);
	return component;
}

function formatBashCall(args: BashParams, theme: Pick<Theme, "fg" | "bold">): string {
	const command = typeof args.command === "string" ? args.command : "";
	const commandDisplay = command.length > 0 ? command : theme.fg("toolOutput", "...");
	const timeoutSuffix = typeof args.timeout === "number" && args.timeout > 0
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}
