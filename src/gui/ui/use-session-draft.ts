import { useCallback, useState, type SetStateAction } from "react";
import type { GuiAction } from "../contract.ts";

export type ImageAttachment = Extract<GuiAction, { action: "prompt" }>["images"][number] & { id: number };
interface Draft { text: string; images: ImageAttachment[]; behavior: "steer" | "followUp" }
const empty: Draft = { text: "", images: [], behavior: "steer" };

/** 更新闭包绑定会话，异步上传或发送失败不会把草稿写进新会话。 */
export function useSessionDraft(sessionId: string | null) {
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const updateFor = useCallback(<K extends keyof Draft>(id: string | null, field: K, value: SetStateAction<Draft[K]>) => {
		if (!id) return;
		setDrafts((current) => {
			const draft = current[id] ?? empty;
			const next = typeof value === "function" ? value(draft[field]) : value;
			return { ...current, [id]: { ...draft, [field]: next } };
		});
	}, []);
	const update = useCallback(<K extends keyof Draft>(field: K, value: SetStateAction<Draft[K]>) => updateFor(sessionId, field, value), [sessionId, updateFor]);
	const writeDraft = useCallback((id: string | null, value: string) => updateFor(id, "text", value), [updateFor]);
	const setDraft = useCallback((value: SetStateAction<string>) => update("text", value), [update]);
	const setImages = useCallback((value: SetStateAction<ImageAttachment[]>) => update("images", value), [update]);
	const setBehavior = useCallback((value: SetStateAction<Draft["behavior"]>) => update("behavior", value), [update]);
	const draft = sessionId ? drafts[sessionId] ?? empty : empty;
	return { draft: draft.text, images: draft.images, behavior: draft.behavior, setDraft, setImages, setBehavior, writeDraft };
}
