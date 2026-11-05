import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { ConfigCommand } from "@/connection/connection.ts";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import type { GuiConfigDocument } from "../../../shared/config/preferences.ts";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import { guiSections, preferenceSave, readPreferenceSource, sectionChanged, type GuiSection, type ReadyGuiConfig } from "./gui-settings-draft.ts";
import { setThemePreview } from "./use-preferences.ts";

type Draft =
	| { kind: "form"; base: ReadyGuiConfig; document: ReadyGuiConfig }
	| { kind: "source"; base: GuiConfigDocument; document: GuiConfigDocument; section: GuiSection };
type GuiSettingsState = {
	latest: GuiConfigDocument;
	document: GuiConfigDocument;
	blocked: boolean;
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
	document: GuiConfigDocument | undefined; send: ConfigCommand; query: Query<GlobalQuery>; disabled: boolean; refresh: () => Promise<void>; children: ReactNode;
}) {
	const [draft, setDraft] = useState<Draft>();
	const previewTheme = draft?.document.state === "ready" ? draft.document.value.theme : undefined;
	useLayoutEffect(() => {
		setThemePreview(previewTheme);
		return () => setThemePreview(undefined);
	}, [previewTheme]);
	const { saving } = useSettingsState();
	const categories = useMemo(() => {
		if (!draft) return [];
		const { base, document } = draft;
		return guiSections.filter((section) => draft.kind === "source" && section === draft.section
			|| base.state === "ready" && document.state === "ready" && sectionChanged(base.value, document.value, section))
			.map((section) => sectionCategories[section]);
	}, [draft]);
	useSettingsDraft("gui", {
		title: "GUI 设置", categories, dirty: draft !== undefined, blocked: disabled,
		save: draft === undefined || draft.document.state === "error" ? null : async () => {
			const content = draft.kind === "form"
				? preferenceSave(draft.base, draft.document, await query({ query: "guiConfig" }))
				: { original: draft.base.content, content: draft.document.content };
			await send({ action: "saveGuiConfig", ...content });
			await refresh();
			setDraft(undefined);
		},
		discard: () => setDraft(undefined),
	});
	const state: GuiSettingsState | undefined = latest && {
		latest, document: draft?.document ?? latest, blocked: disabled || saving,
		update: (previous, next) => {
			const updated: Draft = draft?.kind === "source" ? { ...draft, document: next }
				: { kind: "form", base: draft?.base ?? previous, document: next };
			const changed = updated.kind === "source" ? next.content !== updated.base.content
				: guiSections.some((section) => sectionChanged(updated.base.value, next.value, section));
			setDraft(changed ? updated : undefined);
		},
		changeSource: (content, section) => {
			const base = draft?.base ?? latest;
			setDraft(content === base.content ? undefined : { kind: "source", base, document: readPreferenceSource(base, content), section });
		},
	};
	return <Context value={state}>{children}</Context>;
}
