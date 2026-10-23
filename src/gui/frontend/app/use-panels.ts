import { useCallback, useEffect, useState } from "react";
import type { GuiPanel, GuiSessionTab } from "../../shared/protocol/state.ts";
import { isTouchInput } from "@/ui/input-mode.ts";

export type ViewPanel = GuiPanel | { kind: "usage"; value: "loading" };

export function usePanels(sessionId: string | null) {
	const [panel, setPanel] = useState<ViewPanel>();
	const [sessionTab, setSessionTab] = useState<GuiSessionTab>("tree");
	const [activeTab, setActiveTab] = useState<GuiSessionTab | "file">("tree");
	const [sessionPanelOpen, setSessionPanelOpen] = useState(() => !isTouchInput());
	const selectTab = useCallback((tab: GuiSessionTab | "file") => {
		setActiveTab(tab);
		if (tab !== "file") setSessionTab(tab);
	}, []);
	const closePanel = useCallback(() => setPanel(undefined), []);
	useEffect(() => {
		setPanel((panel) => panel?.kind === "settings" ? panel : undefined);
		setSessionPanelOpen(!isTouchInput());
	}, [sessionId]);
	return { panel, setPanel, closePanel, sessionTab, activeTab, selectTab, sessionPanelOpen, setSessionPanelOpen };
}
