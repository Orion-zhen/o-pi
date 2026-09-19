import { diffList } from "../list-patch.ts";
import type { GuiEvent, GuiSnapshot, GuiSessionInfo, GuiWorkspaceInfo } from "../contract.ts";
import { diffSnapshot, type GuiDelivery, type GuiWireEvent } from "../sync.ts";
import type { GuiPayloads } from "./payloads.ts";

/** 有界发送窗口允许连续推送。窗口满时保留最新状态，不积压 token 事件。 */
export class GuiChannel {
	private current: GuiSnapshot | null = null;
	private sent: GuiSnapshot | null = null;
	private sessions: GuiSessionInfo[] | undefined;
	private workspaces: GuiWorkspaceInfo[] | undefined;
	private dirty = false;
	private pending: Exclude<GuiEvent, { type: "snapshot" | "stream" }>[] = [];
	private sequence = 0;
	private acknowledged = 0;
	private scheduled = false;
	private closed = false;

	constructor(private payloads: () => GuiPayloads, private send: (delivery: GuiDelivery) => void) {}

	accept(event: GuiEvent): void {
		if (this.closed) return;
		if (event.type === "snapshot") {
			this.current = event.value ? this.payloads().snapshot(event.value) : null;
			this.dirty = true;
		} else if (event.type === "stream") {
			if (!this.current || this.current.sessionId !== event.sessionId) return;
			this.current = { ...this.current, streamingMessage: this.payloads().stream(event.value) };
			this.dirty = true;
		} else {
			if (["selected", "activity", "sessionInfo", "sessions", "workspaces", "dialogs", "guiConfig", "notices"].includes(event.type))
				this.pending = this.pending.filter((item) => item.type !== event.type);
			this.pending.push(event.type === "sessionInfo" ? { ...event, value: this.payloads().project(event.value) } : event);
		}
		this.schedule();
	}

	acknowledge(id: number): void {
		if (id <= this.acknowledged || id > this.sequence) return;
		this.acknowledged = id;
		this.schedule();
	}

	private schedule(): void {
		if (this.closed || this.sequence - this.acknowledged >= 4 || this.scheduled || (!this.dirty && !this.pending.length)) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.closed) return;
			const events = this.pending.flatMap((event): GuiWireEvent[] => {
				if (event.type === "sessions") {
					const before = this.sessions;
					this.sessions = event.value;
					if (before) {
						const value = diffList(before, event.value);
						return value ? [{ type: "sessionsPatch", value }] : [];
					}
				}
				if (event.type === "workspaces") {
					const before = this.workspaces;
					this.workspaces = event.value;
					if (before) {
						const value = diffList(before, event.value);
						return value ? [{ type: "workspacesPatch", value }] : [];
					}
				}
				return [event];
			});
			this.pending = [];
			if (this.dirty) {
				const event = this.sent && this.current && this.sent.sessionId === this.current.sessionId
					? diffSnapshot(this.sent, this.current) : { type: "snapshot" as const, value: this.current };
				events.push(event);
				this.sent = this.current;
				this.dirty = false;
			}
			if (events.length) this.send({ id: ++this.sequence, events });
		});
	}

	close(): void {
		this.closed = true;
		this.pending = [];
		this.current = this.sent = null;
		this.sessions = this.workspaces = undefined;
	}
}
