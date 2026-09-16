import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { GuiSessionDetails } from "../contract.ts";
import type { ReadSessionInfo } from "./extensions.ts";

/** 宿主合并会话信息读取，所有页面共用同一份结果。 */
export class GuiSessionInfo {
	value: GuiSessionDetails | undefined;
	private source: { session: AgentSession; read: ReadSessionInfo } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending: Promise<void> | undefined;
	private dirty = false;

	constructor(private publish: (value: GuiSessionDetails) => void, private reportError: (error: unknown) => void) {}

	schedule(session: AgentSession, read: ReadSessionInfo): void {
		if (this.source?.session !== session || this.source.read !== read) {
			this.source = { session, read };
			this.value = undefined;
		}
		this.dirty = true;
		this.enqueue();
	}

	private enqueue(): void {
		if (!this.source || this.pending || this.timer || !this.dirty) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.pending = this.load().finally(() => {
				this.pending = undefined;
				this.enqueue();
			});
		}, 150);
	}

	private async load(): Promise<void> {
		const source = this.source;
		if (!source) return;
		this.dirty = false;
		try {
			const value = await source.read(source.session.extensionRunner.createCommandContext());
			if (this.source === source && source.session.sessionId === value.sessionId) {
				this.value = value;
				this.publish(value);
			}
		} catch (error) {
			if (this.source === source) this.reportError(error);
		}
	}

	invalidate(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.source = undefined;
		this.value = undefined;
		this.dirty = false;
	}

	async dispose(): Promise<void> {
		this.invalidate();
		await this.pending;
	}
}
