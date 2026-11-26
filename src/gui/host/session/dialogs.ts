import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { GuiBashApproval, GuiDialog, GuiDialogContent, GuiNotice } from "../../shared/protocol/state.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import { ALLOW_ONCE, type ApprovalChoice } from "../../../harness/approval/runtime/interaction.ts";
import { approvalText, approvalTarget, environmentLines, hasSensitiveEnvironment, formatApprovalPrompt } from "../../../harness/approval/presentation.ts";
import type { ApprovalPresentationArgs, ApprovalResponse } from "../../../harness/extensions/approval-gate.ts";
import { SudoPassword, type DialogOwner } from "./sudo-password.ts";
import { plainTheme } from "./theme.ts";

const approvalLabels: Record<ApprovalChoice, string> = {
	"Allow once": "允许一次", "Allow for session": "本会话允许", Deny: "拒绝", "Deny with instruction": "拒绝并说明",
};

/** 审批由会话共享，sudo 认证只投递给批准它的客户端。 */
export class GuiDialogs {
	private sudo?: SudoPassword;
	private pending = new Map<string, { dialog: GuiDialog; reveal?: () => GuiBashApproval; finish: (value?: string, owner?: DialogOwner) => void }>();
	readonly notices: GuiNotice[] = [];
	private toolsExpanded = false;
	constructor(private readonly emit: (event: GuiEvent) => void, private readonly tail: () => number,
		private readonly editor: { get(): string; set(value: string): void }) {}

	list(): GuiDialog[] {
		return [...this.pending.values()].map(({ dialog }) => dialog);
	}

	approve(...[request, decision, options, opts, sudoToolCallId]: ApprovalPresentationArgs): Promise<ApprovalResponse> {
		const choices = options.map((value) => ({ label: approvalLabels[value], value }));
		if (request.tool !== "bash") return this.ask({ kind: "select", title: formatApprovalPrompt(request, decision), options: choices }, opts);
		const canReveal = hasSensitiveEnvironment(request);
		const details = (reveal: boolean): GuiBashApproval => ({
			cwd: approvalText(request.cwd), command: approvalText(request.detail.command),
			...(request.detail.environment && { environment: environmentLines(request.detail.environment, reveal) }),
			...(canReveal && { canReveal: true }),
			items: decision.items.map(({ unit, reason }) => ({
				action: unit.action, kind: unit.target.kind, target: approvalTarget(request, unit, reveal), reason: approvalText(reason),
			})),
		});
		const reveal = canReveal ? () => details(true) : undefined;
		const content = { kind: "bashApproval", title: "执行 Bash 命令", approval: details(false), options: choices } as const;
		return new Promise((resolve) => this.open(content, opts, (value, dialog, owner) => {
			if (sudoToolCallId === undefined || value !== ALLOW_ONCE) return resolve(value);
			if (!owner) throw new Error("请在当前会话批准 sudo 命令。");
			this.sudo = new SudoPassword(sudoToolCallId, owner, dialog);
			resolve({ choice: value, askpass: this.sudo.ask });
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

	ask(content: GuiDialogContent, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => this.open(content, opts, resolve));
	}

	private open<T extends GuiDialogContent>(content: T, opts: ExtensionUIDialogOptions | undefined,
		answer: (value: string | undefined, dialog: T & Pick<GuiDialog, "id" | "deadline">, owner?: DialogOwner) => void,
		reveal?: () => GuiBashApproval): void {
		const id = randomUUID();
		const dialog = { ...content, id, deadline: opts?.timeout ? Date.now() + opts.timeout : null };
		if (opts?.signal?.aborted) return answer(undefined, dialog);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const abort = () => finish();
		const finish = (value?: string, owner?: DialogOwner) => {
			answer(value, dialog, owner);
			clearTimeout(timeout);
			opts?.signal?.removeEventListener("abort", abort);
			this.pending.delete(id);
			this.emit({ type: "dialogs", value: this.list() });
		};
		this.pending.set(id, { dialog, finish, ...(reveal && { reveal }) });
		opts?.signal?.addEventListener("abort", abort, { once: true });
		if (opts?.timeout) timeout = setTimeout(abort, opts.timeout);
		this.emit({ type: "dialogs", value: this.list() });
	}

	respond(id: string, value: string | null, owner?: DialogOwner): void {
		if (this.sudoFor(owner)?.respond(id, value)) return;
		const pending = this.pending.get(id);
		if (!pending) throw new Error("对话框已结束，请刷新当前状态。");
		if (value !== null && (pending.dialog.kind === "select" || pending.dialog.kind === "bashApproval")
			&& !pending.dialog.options.some((option) => option.value === value)) throw new Error("无效选项。");
		if (value !== null && pending.dialog.kind === "confirm" && value !== "yes") throw new Error("无效确认。");
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
