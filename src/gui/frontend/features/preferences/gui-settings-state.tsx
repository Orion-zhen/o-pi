import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Send } from "@/connection/connection.ts";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import type { GuiConfigDocument } from "../../../shared/config/preferences.ts";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import { guiSections, preferenceSave, readPreferenceSource, sectionChanged, type GuiSection, type ReadyGuiConfig } from "./gui-settings-draft.ts";

type Draft =
	| { kind: "form"; base: ReadyGuiConfig; document: ReadyGuiConfig }
	| { kind: "source"; base: GuiConfigDocument; document: GuiConfigDocument; section: GuiSection };
type GuiSettingsState = {
	latest: GuiConfigDocument;
	document: GuiConfigDocument;
	blocked: boolean;
	error: string;
	update: (previous: ReadyGuiConfig, next: ReadyGuiConfig) => void;
	changeSource: (content: string, section: GuiSection) => void;
};
const Context = createContext<GuiSettingsState | undefined | null>(null);
const sectionCategories = { appearance: "appearance", interaction: "conversation", desktopWeb: "connections" } as const;

export function useGuiSettings() {
	const state = useContext(Context);
	if (state === null) throw new Error("GUI 设置缺少共享草稿");
	return state;
}

export function GuiSettingsProvider({ document: latest, send, query, disabled, refresh, children }: {
	document: GuiConfigDocument | undefined; send: Send; query: Query<GlobalQuery>; disabled: boolean; refresh: () => Promise<void>; children: ReactNode;
}) {
	const [draft, setDraft] = useState<Draft>();
	const [error, setError] = useState("");
	const { saving } = useSettingsState();
	const categories = useMemo(() => {
		if (!draft) return [];
		const { base, document } = draft;
		return guiSections.filter((section) => draft.kind === "source" && section === draft.section
			|| base.state === "ready" && document.state === "ready" && sectionChanged(base.value, document.value, section))
			.map((section) => sectionCategories[section]);
	}, [draft]);
	useSettingsDraft("gui", {
		title: "GUI 设置", categories, dirty: draft !== undefined, blocked: disabled, invalid: draft?.document.state === "error",
		save: async () => {
			if (!draft) return false;
			setError("");
			const content = draft.kind === "form"
				? preferenceSave(draft.base, draft.document, await query({ query: "guiConfig" }))
				: { original: draft.base.content, content: draft.document.content };
			if (!await send({ action: "saveGuiConfig", ...content })) {
				setError("保存失败，草稿已保留。");
				return false;
			}
			await refresh();
			setDraft(undefined);
			return true;
		},
		discard: () => { setDraft(undefined); setError(""); },
	});
	const state: GuiSettingsState | undefined = latest && {
		latest, document: draft?.document ?? latest, blocked: disabled || saving, error,
		update: (previous, next) => {
			const updated: Draft = draft?.kind === "source" ? { ...draft, document: next }
				: { kind: "form", base: draft?.base ?? previous, document: next };
			const changed = updated.kind === "source" ? next.content !== updated.base.content
				: guiSections.some((section) => sectionChanged(updated.base.value, next.value, section));
			setDraft(changed ? updated : undefined);
			setError("");
		},
		changeSource: (content, section) => {
			const base = draft?.base ?? latest;
			setDraft(content === base.content ? undefined : { kind: "source", base, document: readPreferenceSource(base, content), section });
			setError("");
		},
	};
	return <Context value={state}>{children}</Context>;
}
