import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { GuiApprovalContent, GuiBashApproval, GuiDialog, GuiDialogContent, GuiNotice } from "../../shared/protocol/state.ts";
import type { DialogResponse } from "../../shared/protocol/actions.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import { ALLOW_ONCE, DENY_WITH_INSTRUCTION, answerForChoice, type ApprovalAnswer, type ApprovalChoice } from "../../../harness/approval/runtime/interaction.ts";
import { approvalText, approvalTarget, approvalEnvironment, formatApprovalPrompt } from "../../../harness/approval/presentation.ts";
import type { ApprovalPresentationArgs } from "../../../harness/extensions/approval-gate.ts";
import { SudoPassword, type DialogOwner } from "./sudo-password.ts";
import { plainTheme } from "./theme.ts";

const approvalLabels: Record<ApprovalChoice, string> = {
	"Allow once": "允许一次", "Allow for session": "本会话允许", Deny: "拒绝", "Deny with instruction": "拒绝并说明",
};

interface PendingDialog<T extends GuiDialogContent = GuiDialogContent> {
	dialog: GuiDialog<T>;
	reveal?: () => GuiBashApproval;
	publish(): void;
	finish(value?: string, owner?: DialogOwner): void;
}

/** 审批由会话共享，sudo 认证只投递给批准它的客户端。 */
export class GuiDialogs {
	private sudo?: SudoPassword;
	private pending = new Map<string, PendingDialog>();
	readonly notices: GuiNotice[] = [];
	private toolsExpanded = false;
	constructor(private readonly emit: (event: GuiEvent) => void, private readonly tail: () => number,
		private readonly editor: { get(): string; set(value: string): void }) {}

	list(): GuiDialog[] {
		return [...this.pending.values()].map(({ dialog }) => dialog);
	}

	approve(...[request, decision, options, opts, sudoToolCallId]: ApprovalPresentationArgs): Promise<ApprovalAnswer> {
		const initial = { options: options.map((value) => ({ label: approvalLabels[value], value })), stage: { kind: "choose" } } as const;
		let content: GuiApprovalContent;
		let reveal: (() => GuiBashApproval) | undefined;
		if (request.tool === "bash") {
			const details = (reveal: boolean): GuiBashApproval => ({
				cwd: approvalText(request.cwd), command: approvalText(request.detail.command),
				environment: approvalEnvironment(request.detail.environment, reveal),
				items: decision.items.map(({ unit, reason }) => ({
					action: unit.action, kind: unit.target.kind, target: approvalTarget(request, unit, reveal), reason: approvalText(reason),
				})),
			});
			content = { ...initial, kind: "bashApproval", title: "执行 Bash 命令", approval: details(false) };
			if (content.approval.environment.some((entry) => entry.kind === "hidden")) reveal = () => details(true);
		} else content = { ...initial, kind: "toolApproval", title: formatApprovalPrompt(request, decision) };
		return new Promise((resolve) => this.open(content, opts, (value, dialog, owner) => {
			if (dialog.stage.kind === "instruction") return resolve({ kind: "denied", instruction: value });
			if (dialog.kind !== "bashApproval" || sudoToolCallId === undefined || value !== ALLOW_ONCE) return resolve(answerForChoice(value));
			if (!owner) throw new Error("请在当前会话批准 sudo 命令。");
			this.sudo = new SudoPassword(sudoToolCallId, owner, dialog);
			resolve({ kind: "approved", askpass: this.sudo.ask });
		}, reveal));
	}

	sudoFor(owner: DialogOwner | undefined) { return this.sudo?.owner === owner ? this.sudo : undefined; }

	finishSudo(toolCallId: string): void {
		if (this.sudo?.toolCallId !== toolCallId) return;
		const sudo = this.sudo;
		delete this.sudo;
		sudo.close();
	}

	reveal(id: string): GuiBashApproval {
		const details = this.pending.get(id)?.reveal;
		if (!details) throw new Error("该对话框没有可查看的敏感值。");
		return details();
	}

	ask(content: Exclude<GuiDialogContent, GuiApprovalContent>, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => this.open(content, opts, resolve));
	}

	private open<T extends GuiDialogContent>(content: T, opts: ExtensionUIDialogOptions | undefined,
		answer: (value: string | undefined, dialog: GuiDialog<T>, owner?: DialogOwner) => void, reveal?: () => GuiBashApproval): void {
		const id = randomUUID();
		const dialog = { ...content, id, deadline: null };
		if (opts?.signal?.aborted) return answer(undefined, dialog);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => pending.finish();
		const pending: PendingDialog<T> = {
			dialog, ...(reveal && { reveal }),
			publish: () => {
				if (opts?.timeout) {
					clearTimeout(timer);
					pending.dialog = { ...pending.dialog, deadline: Date.now() + opts.timeout };
					timer = setTimeout(abort, opts.timeout);
				}
				this.emit({ type: "dialogs", value: this.list() });
			},
			finish: (value, owner) => {
				answer(value, pending.dialog, owner);
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				this.emit({ type: "dialogs", value: this.list() });
			},
		};
		this.pending.set(id, pending);
		opts?.signal?.addEventListener("abort", abort, { once: true });
		pending.publish();
	}

	respond(response: DialogResponse, owner?: DialogOwner): void {
		if (this.sudoFor(owner)?.respond(response)) return;
		const { id, token, value } = response;
		const pending = this.pending.get(id);
		if (!pending) throw new Error("对话框已结束，请刷新当前状态。");
		const { dialog } = pending;
		const stage = "stage" in dialog ? dialog.stage : undefined;
		if (token !== (stage?.kind === "instruction" ? stage.token : undefined)) throw new Error("对话框阶段已变更，请刷新当前状态。");
		if (value !== null && stage?.kind !== "instruction" && "options" in dialog) {
			if (!dialog.options.some((option) => option.value === value)) throw new Error("无效选项。");
			if ("stage" in dialog && value === DENY_WITH_INSTRUCTION) {
				pending.dialog = { ...dialog, stage: { kind: "instruction", token: randomUUID() } };
				pending.publish();
				return;
			}
		}
		if (value !== null && dialog.kind === "confirm" && value !== "yes") throw new Error("无效确认。");
		pending.finish(value ?? undefined, owner);
	}

	cancel(): void {
		if (this.sudo) this.finishSudo(this.sudo.toolCallId);
		for (const pending of [...this.pending.values()]) pending.finish(undefined);
	}

	notify(text: string, type: GuiNotice["type"] = "info"): void {
		this.notices.push({ id: randomUUID(), type, text, anchor: this.tail() });
		if (this.notices.length > 100) this.notices.shift();
		this.emit({ type: "notices", value: [...this.notices] });
	}

	clearNotices(ids: string[]): void {
		const kept = this.notices.filter((notice) => !ids.includes(notice.id));
		if (kept.length === this.notices.length) return;
		this.notices.splice(0, this.notices.length, ...kept);
		this.emit({ type: "notices", value: [...this.notices] });
	}

	context(): ExtensionUIContext {
		const unsupported = (): never => {
			throw new Error("此扩展使用了 GUI 不支持的终端组件。");
		};
		// GUI 没有终端状态栏，保留接口但不维护不可见的影子状态。
		const ignore = () => {};
		return {
			select: (title, options, opts) => this.ask({ kind: "select", title, options: options.map((value) => ({ label: value, value })) }, opts),
			confirm: async (title, message, opts) => (await this.ask({ kind: "confirm", title, message }, opts)) === "yes",
			input: (title, placeholder, opts) => this.ask({ kind: "input", title, placeholder: placeholder ?? "", initial: "" }, opts),
			editor: (title, prefill) => this.ask({ kind: "editor", title, initial: prefill ?? "" }),
			notify: (message, type) => this.notify(message, type),
			setStatus: ignore,
			setTitle: ignore,
			setWorkingMessage: ignore,
			setWorkingVisible: ignore,
			setWorkingIndicator: unsupported,
			setHiddenThinkingLabel: ignore,
			setWidget: (_key, content) => { if (content !== undefined && !Array.isArray(content)) unsupported(); },
			setEditorText: (text) => {
				this.editor.set(text);
			},
			pasteToEditor: (text) => {
				const value = this.editor.get() + text;
				this.editor.set(value);
			},
			getEditorText: () => this.editor.get(),
			onTerminalInput: unsupported,
			setFooter: unsupported,
			setHeader: unsupported,
			custom: unsupported,
			addAutocompleteProvider: unsupported,
			setEditorComponent: unsupported,
			getEditorComponent: () => undefined,
			theme: plainTheme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "GUI 不使用终端主题。" }),
			getToolsExpanded: () => this.toolsExpanded,
			setToolsExpanded: (expanded) => {
				this.toolsExpanded = expanded;
			},
		};
	}
}
