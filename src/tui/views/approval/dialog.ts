import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { borderedPanelContentWidth, renderBorderedPanel } from "../../components/scroll-viewer.ts";
import { buildApprovalContent, finishApprovalChoice, type ApprovalDisplayLine, type ApprovalLineStyle } from "../../../harness/approval/presentation.ts";
import {
	ALLOW_ONCE, ALLOW_SESSION, DENY_WITH_INSTRUCTION, answerForReview,
	type ApprovalAnswer, type ApprovalChoice, type ApprovalDialogOptions, type ApprovalOptions,
} from "../../../harness/approval/runtime/interaction.ts";
import type { ApprovalDecision, ApprovalRequest } from "../../../harness/approval/types.ts";
import { DialogTiming, type ReviewOpinion, type ReviewState } from "../../../harness/approval/runtime/ai-review.ts";
import { requestSudoPassword } from "./sudo-password.ts";

const HEIGHT_RATIO = 0.9;
const FIXED_INNER_ROWS = 4;
type AskDecision = Extract<ApprovalDecision, { kind: "ask" }>;

type ApprovalDialogResult = ApprovalChoice | ReviewOpinion | undefined;

export async function openApprovalDialog(
	ui: Pick<ExtensionUIContext, "custom" | "input">,
	request: ApprovalRequest,
	decision: AskDecision,
	options: ApprovalOptions,
	dialogOptions?: ApprovalDialogOptions,
	sudoToolCallId?: string,
): Promise<ApprovalAnswer> {
	if (dialogOptions?.signal?.aborted) return { kind: "denied" };
	const result = await ui.custom<ApprovalDialogResult>(
		(tui, theme, _keybindings, done) => new ApprovalDialog(
			request, decision, options, theme,
			() => tui.terminal.rows, () => tui.requestRender(), done, dialogOptions,
		),
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } },
	);
	if (typeof result === "object") return answerForReview(result);
	if (result === ALLOW_ONCE && sudoToolCallId !== undefined) return { kind: "approved", askpass: (retry, signal) => requestSudoPassword(ui, retry, signal) };
	return finishApprovalChoice(result, ui, dialogOptions);
}

/** 高度受限的审批面板，内容滚动与操作选择相互独立。 */
export class ApprovalDialog implements Component {
	private selectedChoice: ApprovalChoice;
	private scrollTop = 0;
	private bodyHeight = 1;
	private renderedBodyLines = 0;
	private content: ApprovalDisplayLine[];
	private showEnvironment = false;
	private review?: ReviewState;
	private closed = false;
	private readonly timing: DialogTiming;
	private countdownTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly request: ApprovalRequest,
		private readonly decision: AskDecision,
		private readonly options: ApprovalOptions,
		private readonly theme: Pick<Theme, "fg" | "bg" | "bold">,
		private readonly getRows: () => number,
		private readonly requestRender: () => void,
		private readonly done: (result: ApprovalDialogResult) => void,
		private readonly opts?: ApprovalDialogOptions,
	) {
		this.selectedChoice = options[0];
		this.content = buildApprovalContent(request, decision);
		this.timing = new DialogTiming(opts?.timeout, this.cancel);
		opts?.signal?.addEventListener("abort", this.cancel, { once: true });
		if (this.timing.deadline !== null) this.countdownTimer = setInterval(this.requestRender, 1000);
		if (opts?.review) this.timing.startReview(opts.review, state => {
			this.review = state;
			if (state.kind === "ready" && state.end !== null) {
				clearInterval(this.countdownTimer);
				this.countdownTimer = setInterval(this.requestRender, 250);
			}
			this.requestRender();
		}, opinion => this.finish(opinion));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.finish(this.selectedChoice);
			return;
		}
		if (data === "e" && "units" in this.request && this.request.detail.environment !== undefined) {
			this.showEnvironment = !this.showEnvironment;
			this.content = buildApprovalContent(this.request, this.decision, this.showEnvironment);
		} else if (matchesKey(data, Key.up)) this.selectBy(-1);
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
		const body = [...(this.review ? [{ text: reviewLabel(this.review), style: "warning" as const }] : []), ...this.content].flatMap((line) =>
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

	private readonly cancel = () => this.finish(undefined);
	private finish(result: ApprovalDialogResult): void {
		if (this.closed) return;
		this.dispose();
		this.done(result);
	}

	dispose(): void {
		this.closed = true;
		this.timing.stop();
		this.opts?.signal?.removeEventListener("abort", this.cancel);
		clearInterval(this.countdownTimer);
	}

	private renderCompact(width: number, rowBudget: number): string[] {
		return [
			...(rowBudget > 1 ? [this.theme.fg("warning", this.theme.bold(`Approval required | ${this.request.tool}`))] : []),
			this.theme.fg("accent", `> ${this.selectedChoice}`),
			...(this.review ? [this.theme.fg("warning", reviewLabel(this.review).replace(/\s+/gu, " "))] : []),
			this.theme.fg("dim", this.footer()),
		].slice(0, rowBudget).map((line) => truncateToWidth(line, width, ""));
	}

	private renderOptions(width: number, visibleRows: number): string[] {
		const selectedIndex = this.options.indexOf(this.selectedChoice);
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), this.options.length - visibleRows));
		return this.options.slice(start, start + visibleRows).map((option) => {
			const selected = option === this.selectedChoice;
			const description = width >= 64 ? ` - ${optionDescription(option)}` : "";
			const state = this.review;
			const suggested = state?.kind === "ready" && option === (state.decision === "allow" ? ALLOW_ONCE : "Deny");
			const line = truncateToWidth(`${selected ? "> " : "  "}${suggested ? "[AI] " : ""}${option}${description}`, width, "");
			if (suggested && state.end !== null) {
				const filled = Math.floor(Math.max(0, Math.min(1, (Date.now() - state.start) / (state.end - state.start))) * line.length);
				return this.theme.fg("accent", this.theme.bg("selectedBg", line.slice(0, filled)) + line.slice(filled));
			}
			return selected ? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(line))) : line;
		});
	}

	private footer(): string {
		const position = `${this.options.indexOf(this.selectedChoice) + 1}/${this.options.length}`;
		const remaining = this.timing.deadline === null
			? "" : ` | timeout ${Math.max(0, Math.ceil((this.timing.deadline - Date.now()) / 1000))}s`;
		const env = "units" in this.request && this.request.detail.environment !== undefined ? "E show/hide values | " : "";
		return `${env}Up/Down choose ${position} | PgUp/PgDn scroll | Enter confirm | Esc deny${remaining}`;
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

function reviewLabel(review: ReviewState): string {
	return review.kind === "ready" ? `AI: ${review.decision} | ${review.reason}` : review.kind === "running" ? "AI: reviewing" : "AI: unavailable";
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
	if (option === DENY_WITH_INSTRUCTION) return "block and tell the agent what to do instead";
	return "block this call";
}
