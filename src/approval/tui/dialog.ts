import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

import {
	ALLOW_ONCE,
	ALLOW_PERSISTENT,
	ALLOW_SESSION,
	DENY_WITH_INSTRUCTION,
	type ApprovalChoice,
	type ApprovalDialogOptions,
	type ApprovalOptions,
} from "../runtime/interaction.js";
import type { ApprovalDecision, ApprovalRequest } from "../types.js";

const HEIGHT_RATIO = 0.9;
const FRAME_WIDTH = 4;
const FIXED_INNER_ROWS = 4;

type AskDecision = Extract<ApprovalDecision, { kind: "ask" }>;
type LineStyle = "text" | "dim" | "added" | "removed" | "warning";

interface DisplayLine {
	text: string;
	style: LineStyle;
}

export async function openApprovalDialog(
	ui: Pick<ExtensionUIContext, "custom">,
	request: ApprovalRequest,
	decision: AskDecision,
	options: ApprovalOptions,
	dialogOptions?: ApprovalDialogOptions,
): Promise<string | undefined> {
	return ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => new ApprovalDialog(
			request,
			decision,
			options,
			theme,
			() => tui.terminal.rows,
			() => tui.requestRender(),
			done,
			dialogOptions?.timeout,
		),
		{
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 },
		},
	);
}

/** 高度受限的审批面板。内容滚动与操作选择相互独立。 */
export class ApprovalDialog implements Component {
	private selectedChoice: ApprovalChoice;
	private scrollTop = 0;
	private bodyHeight = 1;
	private renderedBodyLines = 0;
	private readonly expiresAt: number | undefined;
	private readonly timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly countdownTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly request: ApprovalRequest,
		private readonly decision: AskDecision,
		private readonly options: ApprovalOptions,
		private readonly theme: Pick<Theme, "fg" | "bg" | "bold">,
		private readonly getRows: () => number,
		private readonly requestRender: () => void,
		private readonly done: (choice: string | undefined) => void,
		timeoutMs?: number,
	) {
		this.selectedChoice = options[0];
		if (timeoutMs !== undefined) {
			this.expiresAt = Date.now() + timeoutMs;
			this.timeoutTimer = setTimeout(() => this.done(undefined), timeoutMs);
			this.countdownTimer = setInterval(this.requestRender, 1000);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.selectedChoice);
			return;
		}

		if (matchesKey(data, Key.up)) this.selectBy(-1);
		else if (matchesKey(data, Key.down)) this.selectBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.bodyHeight);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.bodyHeight);
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = Number.MAX_SAFE_INTEGER;
		else return;
		this.requestRender();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const rowBudget = Math.max(1, Math.floor(this.getRows() * HEIGHT_RATIO));
		if (width <= FRAME_WIDTH || rowBudget < 8) return this.renderCompact(width, rowBudget);

		const contentWidth = width - FRAME_WIDTH;
		const body = wrapDisplayLines(buildBody(this.request, this.decision), contentWidth, this.theme);
		this.renderedBodyLines = body.length;

		const availableRows = rowBudget - 2 - FIXED_INNER_ROWS;
		const optionRows = Math.min(this.options.length, Math.max(1, availableRows - 1));
		this.bodyHeight = Math.max(1, availableRows - optionRows);
		this.clampScroll();

		const visibleBody = body.slice(this.scrollTop, this.scrollTop + this.bodyHeight);
		while (visibleBody.length < this.bodyHeight) visibleBody.push("");
		const bodyEnd = Math.min(this.renderedBodyLines, this.scrollTop + this.bodyHeight);
		const sectionTitle = this.theme.fg(
			"muted",
			`Request details  ${this.scrollTop + 1}-${bodyEnd}/${this.renderedBodyLines}`,
		);

		const innerLines = [
			this.theme.fg("warning", this.theme.bold(`Approval required | ${this.request.tool}`)),
			sectionTitle,
			...visibleBody,
			this.theme.fg("borderMuted", "-".repeat(contentWidth)),
			...this.renderOptions(contentWidth, optionRows),
			this.theme.fg("dim", this.footer()),
		];
		return this.frame(innerLines, width);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timeoutTimer !== undefined) clearTimeout(this.timeoutTimer);
		if (this.countdownTimer !== undefined) clearInterval(this.countdownTimer);
	}

	private renderCompact(width: number, rowBudget: number): string[] {
		return [
			this.theme.fg("warning", this.theme.bold(`Approval required | ${this.request.tool}`)),
			this.theme.fg("accent", `> ${this.selectedChoice}`),
			this.theme.fg("dim", this.footer()),
		].slice(0, rowBudget).map((line) => truncateToWidth(line, width, ""));
	}

	private renderOptions(width: number, visibleRows: number): string[] {
		const selectedIndex = this.options.indexOf(this.selectedChoice);
		const start = Math.max(0, Math.min(
			selectedIndex - Math.floor(visibleRows / 2),
			this.options.length - visibleRows,
		));
		return this.options.slice(start, start + visibleRows).map((option) => {
			const selected = option === this.selectedChoice;
			const prefix = selected ? "> " : "  ";
			const description = width >= 64 ? ` - ${optionDescription(option)}` : "";
			const line = truncateToWidth(`${prefix}${option}${description}`, width, "");
			return selected
				? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(line)))
				: line;
		});
	}

	private footer(): string {
		const position = `${this.options.indexOf(this.selectedChoice) + 1}/${this.options.length}`;
		const remaining = this.expiresAt === undefined
			? ""
			: ` | timeout ${Math.max(0, Math.ceil((this.expiresAt - Date.now()) / 1000))}s`;
		return `Up/Down choose ${position} | PgUp/PgDn scroll | Enter confirm | Esc deny${remaining}`;
	}

	private selectBy(delta: number): void {
		const selectedIndex = this.options.indexOf(this.selectedChoice);
		const targetIndex = (selectedIndex + delta + this.options.length) % this.options.length;
		for (const [index, option] of this.options.entries()) {
			if (index === targetIndex) {
				this.selectedChoice = option;
				return;
			}
		}
	}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
		this.clampScroll();
	}

	private clampScroll(): void {
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, this.renderedBodyLines - this.bodyHeight));
	}

	private frame(lines: string[], width: number): string[] {
		const innerWidth = width - 2;
		const contentWidth = width - FRAME_WIDTH;
		const border = (text: string) => this.theme.fg("border", text);
		const row = (line: string) => `${border("|")} ${truncateToWidth(line, contentWidth, "", true)} ${border("|")}`;
		return [border(`+${"-".repeat(innerWidth)}+`), ...lines.map(row), border(`+${"-".repeat(innerWidth)}+`)];
	}
}

function buildBody(request: ApprovalRequest, decision: AskDecision): DisplayLine[] {
	const reasons = [...new Set(decision.items.map((item) => item.reason))];
	const common: DisplayLine[] = [
		line(`Working directory: ${request.cwd}`, "dim"),
		...reasons.map((reason) => line(`Reason: ${reason}`, "warning")),
		line(""),
	];

	if (request.detail.kind === "bash") {
		return [
			...common,
			line(`Command (${lineCount(request.detail.command)} lines):`, "dim"),
			...payloadLines(request.detail.command, "text"),
			line(""),
			line("Sensitive units:", "dim"),
			...decision.items.flatMap((item, index) => [
				line(`${index + 1}. ${item.unit.target.value}`),
				line(`   ${item.unit.action} | ${item.reason}`, "warning"),
			]),
		];
	}

	if (request.detail.kind === "write") {
		return [
			line(`Target: ${request.detail.path}`),
			...common,
			line(`Proposed content (${lineCount(request.detail.content)} lines, ${request.detail.content.length} chars):`, "dim"),
			...prefixedPayloadLines(request.detail.content, "+ ", "added"),
		];
	}

	return [
		line(`Target: ${request.detail.path}`),
		...common,
		...request.detail.edits.flatMap((edit, index) => [
			line(`Replacement ${index + 1}${edit.replace_all ? " (all matches)" : ""}:`, "dim"),
			...prefixedPayloadLines(edit.old, "- ", "removed"),
			...prefixedPayloadLines(edit.new, "+ ", "added"),
			line(""),
		]),
	];
}

function payloadLines(payload: string, style: LineStyle): DisplayLine[] {
	return safePayload(payload).split("\n").map((text) => line(text, style));
}

function prefixedPayloadLines(payload: string, prefix: string, style: LineStyle): DisplayLine[] {
	return safePayload(payload).split("\n").map((text) => line(`${prefix}${text}`, style));
}

function safePayload(payload: string): string {
	return stripTerminalSequences(payload)
		.replace(/\r\n?/gu, "\n")
		.replace(/\t/gu, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?");
}

function line(text: string, style: LineStyle = "text"): DisplayLine {
	return { text, style };
}

function wrapDisplayLines(
	lines: readonly DisplayLine[],
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	return lines.flatMap((displayLine) => {
		const wrapped = wrapTextWithAnsi(displayLine.text, width);
		return wrapped.map((text) => styleLine(text, displayLine.style, theme));
	});
}

function styleLine(text: string, style: LineStyle, theme: Pick<Theme, "fg">): string {
	if (style === "dim") return theme.fg("dim", text);
	if (style === "added") return theme.fg("toolDiffAdded", text);
	if (style === "removed") return theme.fg("toolDiffRemoved", text);
	if (style === "warning") return theme.fg("warning", text);
	return theme.fg("toolOutput", text);
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split(/\r\n?|\n/u).length;
}

function optionDescription(option: ApprovalChoice): string {
	if (option === ALLOW_ONCE) return "run only this call";
	if (option === ALLOW_SESSION) return "remember exact sensitive units for this session";
	if (option === ALLOW_PERSISTENT) return "save conservative rules for similar calls";
	if (option === DENY_WITH_INSTRUCTION) return "block and tell the agent what to do instead";
	return "block this call";
}
