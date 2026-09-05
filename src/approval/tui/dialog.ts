import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { borderedPanelContentWidth, renderBorderedPanel } from "../../tui/bordered-scroll-viewer.js";
import { buildApprovalContent, type ApprovalDisplayLine, type ApprovalLineStyle } from "../presentation.js";
import {
	ALLOW_ONCE, ALLOW_PERSISTENT, ALLOW_SESSION, DENY_WITH_INSTRUCTION,
	type ApprovalChoice, type ApprovalDialogOptions, type ApprovalOptions,
} from "../runtime/interaction.js";
import type { ApprovalDecision, ApprovalRequest } from "../types.js";

const HEIGHT_RATIO = 0.9;
const FIXED_INNER_ROWS = 4;
type AskDecision = Extract<ApprovalDecision, { kind: "ask" }>;

export async function openApprovalDialog(
	ui: Pick<ExtensionUIContext, "custom">,
	request: ApprovalRequest,
	decision: AskDecision,
	options: ApprovalOptions,
	dialogOptions?: ApprovalDialogOptions,
): Promise<string | undefined> {
	return ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => new ApprovalDialog(
			request, decision, options, theme,
			() => tui.terminal.rows, () => tui.requestRender(), done, dialogOptions?.timeout,
		),
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 80, maxHeight: "90%", margin: 1 } },
	);
}

/** 高度受限的审批面板，内容滚动与操作选择相互独立。 */
export class ApprovalDialog implements Component {
	private selectedChoice: ApprovalChoice;
	private scrollTop = 0;
	private bodyHeight = 1;
	private renderedBodyLines = 0;
	private readonly content: ApprovalDisplayLine[];
	private readonly expiresAt: number | undefined;
	private readonly timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly countdownTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly request: ApprovalRequest,
		decision: AskDecision,
		private readonly options: ApprovalOptions,
		private readonly theme: Pick<Theme, "fg" | "bg" | "bold">,
		private readonly getRows: () => number,
		private readonly requestRender: () => void,
		private readonly done: (choice: string | undefined) => void,
		timeoutMs?: number,
	) {
		this.selectedChoice = options[0];
		this.content = buildApprovalContent(request, decision);
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
		const contentWidth = borderedPanelContentWidth(width);
		if (contentWidth < 1 || rowBudget < 8) return this.renderCompact(width, rowBudget);
		const body = this.content.flatMap((line) =>
			wrapTextWithAnsi(line.text, contentWidth).map((text) => this.theme.fg(lineColor(line.style), text)));
		this.renderedBodyLines = body.length;
		const availableRows = rowBudget - 2 - FIXED_INNER_ROWS;
		const optionRows = Math.min(this.options.length, Math.max(1, availableRows - 1));
		this.bodyHeight = Math.max(1, Math.min(body.length, availableRows - optionRows));
		this.clampScroll();
		const visibleBody = body.slice(this.scrollTop, this.scrollTop + this.bodyHeight);
		while (visibleBody.length < this.bodyHeight) visibleBody.push("");
		const bodyEnd = Math.min(this.renderedBodyLines, this.scrollTop + this.bodyHeight);
		return renderBorderedPanel([
			this.theme.fg("warning", this.theme.bold(`Approval required | ${this.request.tool}`)),
			this.theme.fg("muted", `Request details  ${this.scrollTop + 1}-${bodyEnd}/${this.renderedBodyLines}`),
			...visibleBody,
			this.theme.fg("text", "─".repeat(contentWidth)),
			...this.renderOptions(contentWidth, optionRows),
			this.theme.fg("dim", this.footer()),
		], width, this.theme);
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
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), this.options.length - visibleRows));
		return this.options.slice(start, start + visibleRows).map((option) => {
			const selected = option === this.selectedChoice;
			const description = width >= 64 ? ` - ${optionDescription(option)}` : "";
			const line = truncateToWidth(`${selected ? "> " : "  "}${option}${description}`, width, "");
			return selected ? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(line))) : line;
		});
	}

	private footer(): string {
		const position = `${this.options.indexOf(this.selectedChoice) + 1}/${this.options.length}`;
		const remaining = this.expiresAt === undefined
			? "" : ` | timeout ${Math.max(0, Math.ceil((this.expiresAt - Date.now()) / 1000))}s`;
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
}

function lineColor(style: ApprovalLineStyle): Parameters<Theme["fg"]>[0] {
	if (style === "dim") return "dim";
	if (style === "added") return "toolDiffAdded";
	if (style === "removed") return "toolDiffRemoved";
	if (style === "warning") return "warning";
	return "toolOutput";
}

function optionDescription(option: ApprovalChoice): string {
	if (option === ALLOW_ONCE) return "run only this call";
	if (option === ALLOW_SESSION) return "remember exact sensitive units for this session";
	if (option === ALLOW_PERSISTENT) return "save conservative rules for similar calls";
	if (option === DENY_WITH_INSTRUCTION) return "block and tell the agent what to do instead";
	return "block this call";
}
