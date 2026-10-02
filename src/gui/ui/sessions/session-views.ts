import type { VirtualItem } from "@tanstack/react-virtual";
import type { GuiAction, GuiEvent } from "../../contract.ts";
import type { DisclosureMemory } from "../components/disclosure-memory.ts";

export type ImageAttachment = Extract<GuiAction, { action: "prompt" }>["images"][number] & { id: number };
export interface Draft { text: string; images: ImageAttachment[]; behavior: "steer" | "followUp" }
export interface SessionViewState {
	id: string;
	path: string | null;
	draft: Draft;
	disclosures: DisclosureMemory;
	measurements: VirtualItem[];
	position: { top: number; follow: boolean } | undefined;
}

/** 只有显式打开创建记录。异步回调只能更新仍属于本次打开的记录。 */
export class SessionViews {
	private records = new Map<string, SessionViewState>();
	private listeners = new Map<SessionViewState, Set<() => void>>();
	subscribe(record: SessionViewState, listener: () => void): () => void {
		let listeners = this.listeners.get(record);
		if (!listeners) { listeners = new Set(); this.listeners.set(record, listeners); }
		listeners.add(listener);
		return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(record); };
	}
	open(session: { id: string; path: string | null }, draftFrom?: string): SessionViewState {
		let record = this.records.get(session.id);
		if (!record) {
			record = { ...session, draft: { text: "", images: [], behavior: "steer" }, disclosures: new Map(), measurements: [], position: undefined };
			this.records.set(session.id, record);
		}
		const previous = draftFrom ? this.records.get(draftFrom) : undefined;
		if (previous) record.draft = { ...previous.draft, images: [...previous.draft.images] };
		record.path = session.path;
		return record;
	}
	get(id: string): SessionViewState | undefined { return this.records.get(id); }
	writeText(id: string, text: string): void {
		const record = this.records.get(id);
		if (record) this.update(record, (draft) => ({ ...draft, text }));
	}
	update(record: SessionViewState, change: (draft: Draft) => Draft): boolean {
		if (this.records.get(record.id) !== record) return false;
		record.draft = change(record.draft);
		for (const listener of this.listeners.get(record) ?? []) listener();
		return true;
	}
	remove(event: Extract<GuiEvent, { type: "sessionsDeleted" }>): string[] {
		const ids = new Set(event.ids);
		for (const record of this.records.values()) {
			if (ids.has(record.id) || record.path && event.paths.includes(record.path)) {
				ids.add(record.id);
				this.records.delete(record.id);
			}
		}
		return [...ids];
	}
}
