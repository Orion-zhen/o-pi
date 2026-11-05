import { AsyncLocalStorage } from "node:async_hooks";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import type { GuiSnapshot } from "../../shared/protocol/state.ts";
import { GuiDialogs } from "./dialogs.ts";
import { GuiReports } from "../projection/reports.ts";
import { UsageService } from "../../../harness/usage/service.ts";
import { GuiModelScope } from "./models.ts";
import { GuiModelServices } from "./model-services.ts";
import type { SessionClient } from "./execution.ts";
import type { AutoTitleGenerator } from "../../../harness/extensions/auto-title.ts";

/** 启动和执行共用交互通道，审批与取消不等待 SDK 就绪。 */
export class GuiExecutionContext {
	readonly origin = new AsyncLocalStorage<SessionClient>();
	readonly lifetime = new AbortController();
	commandController = new AbortController();
	readonly usageService = new UsageService();
	readonly modelScope = new GuiModelScope();
	readonly modelServices = new GuiModelServices();
	titleGeneration: GuiSnapshot["titleGeneration"];
	autoTitle: AutoTitleGenerator | undefined;
	tail = () => 0;
	publish: () => void;
	readonly reports = new GuiReports(
		(event) => this.emit(event),
		(error) => this.dialogs.notify(`会话信息读取失败: ${error instanceof Error ? error.message : String(error)}`, "error"),
	);
	readonly dialogs = new GuiDialogs((event) => {
		this.emit(event);
		this.changed();
	}, () => this.tail(), {
		get: () => this.origin.getStore()?.readDraft() ?? "",
		set: (text) => {
			this.origin.getStore()?.writeDraft(text);
			this.emit({ type: "editor", sessionId: this.id, text, mode: "replace" });
		},
	});

	constructor(readonly id: string, private receive: (event: GuiEvent) => void, readonly changed: () => void,
		readonly refreshSessions: () => void, readonly submitted: () => void) {
		this.publish = changed;
	}

	emit(event: GuiEvent): void {
		if (["panel", "sessionTab", "editor", "download", "auth", "close"].includes(event.type)) {
			this.origin.getStore()?.emit(event);
			return;
		}
		this.receive(event);
	}
	cancel(): void {
		this.dialogs.cancel();
		this.commandController.abort();
		this.commandController = new AbortController();
	}
	close(): void {
		this.lifetime.abort();
		this.commandController.abort();
		this.dialogs.cancel();
	}
}
