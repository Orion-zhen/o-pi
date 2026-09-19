import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { GuiBashApproval, GuiDialog, GuiEvent, GuiNotice } from "../contract.ts";
import type { ApprovalInteractionPort } from "../../harness/approval/runtime/interaction.ts";
import { approvalText, formatApprovalPrompt } from "../../harness/approval/presentation.ts";
import { plainTheme } from "./theme.ts";

/** 对话框属于宿主，不随浏览器连接销毁。响应只能消费一次。 */
export class GuiDialogs {
	private pending = new Map<string, { dialog: GuiDialog; finish: (value: string | undefined) => void }>();
	readonly notices: GuiNotice[] = [];
	readonly status: Record<string, string> = {};
	draft = "";
	constructor(private readonly emit: (event: GuiEvent) => void, private readonly tail: () => number = () => 0) {}

	list(): GuiDialog[] {
		return [...this.pending.values()].map(({ dialog }) => dialog);
	}

	approve(...[request, decision, options, opts]: Parameters<ApprovalInteractionPort["approve"]>): Promise<string | undefined> {
		const bash: GuiBashApproval | undefined = request.tool === "bash" ? {
			cwd: approvalText(request.cwd), command: approvalText(request.detail.command),
			items: decision.items.map(({ unit, reason }) => ({
				action: unit.action, kind: unit.target.kind, target: approvalText(unit.target.value), reason: approvalText(reason),
			})),
		} : undefined;
		return this.ask("select", bash ? "执行 Bash 命令" : formatApprovalPrompt(request, decision), "", [...options], "", opts, bash);
	}

	ask(
		kind: GuiDialog["kind"],
		title: string,
		message = "",
		options: string[] = [],
		initial = "",
		opts?: ExtensionUIDialogOptions,
		bash?: GuiBashApproval,
	): Promise<string | undefined> {
		if (opts?.signal?.aborted) return Promise.resolve(undefined);
		const id = randomUUID();
		return new Promise((resolve) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const abort = () => finish(undefined);
			const finish = (value: string | undefined) => {
				clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				this.emit({ type: "dialogs", value: this.list() });
				resolve(value);
			};
			this.pending.set(id, {
				dialog: {
					id,
					kind,
					title,
					message,
					options,
					initial,
					deadline: opts?.timeout ? Date.now() + opts.timeout : null,
					...(bash ? { bash } : {}),
				},
				finish,
			});
			opts?.signal?.addEventListener("abort", abort, { once: true });
			if (opts?.timeout) timeout = setTimeout(abort, opts.timeout);
			this.emit({ type: "dialogs", value: this.list() });
		});
	}

	respond(id: string, value: string | null): void {
		const pending = this.pending.get(id);
		if (!pending) throw new Error("对话框已结束，请刷新当前状态。");
		if (value !== null && pending.dialog.kind === "select" && !pending.dialog.options.includes(value))
			throw new Error("无效选项。");
		if (value !== null && pending.dialog.kind === "confirm" && value !== "yes") throw new Error("无效确认。");
		pending.finish(value ?? undefined);
	}

	cancel(): void {
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
		return {
			select: (title, options, opts) => this.ask("select", title, "", options, "", opts),
			confirm: async (title, message, opts) => (await this.ask("confirm", title, message, [], "", opts)) === "yes",
			input: (title, placeholder, opts) => this.ask("input", title, placeholder ?? "", [], "", opts),
			editor: (title, prefill) => this.ask("editor", title, "", [], prefill ?? ""),
			notify: (message, type) => this.notify(message, type),
			setStatus: (key, text) => {
				if (text === undefined) delete this.status[key];
				else this.status[key] = text;
			},
			setTitle: (title) => {
				this.status["title"] = title;
			},
			setWorkingMessage: (message) => {
				if (message === undefined) delete this.status["working"];
				else this.status["working"] = message;
			},
			setWorkingVisible: (visible) => {
				this.status["workingVisible"] = String(visible);
			},
			setWorkingIndicator: unsupported,
			setHiddenThinkingLabel: (label) => {
				this.status["thinkingLabel"] = label ?? "思考";
			},
			setWidget: (key, content) => {
				if (Array.isArray(content)) this.status[key] = content.join("\n");
				else if (content === undefined) delete this.status[key];
				else unsupported();
			},
			setEditorText: (text) => {
				this.draft = text;
				this.emit({ type: "editor", text });
			},
			pasteToEditor: (text) => {
				this.draft += text;
				this.emit({ type: "editor", text: this.draft });
			},
			getEditorText: () => this.draft,
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
			getToolsExpanded: () => this.status["toolsExpanded"] === "true",
			setToolsExpanded: (expanded) => {
				this.status["toolsExpanded"] = String(expanded);
			},
		};
	}
}
