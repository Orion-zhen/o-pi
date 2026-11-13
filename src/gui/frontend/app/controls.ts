import type { GuiAction } from "../../shared/protocol/actions.ts";
import type { GuiPanel, GuiSessionInfo } from "../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import type { WorkspaceSelectionView } from "@/features/workspace/workspace-selection.tsx";
import type { SessionListItem } from "@/features/sessions/session-list.ts";
import type { WorkbenchView } from "@/features/workspace/use-workbench.ts";
import type { SessionSearchView } from "@/features/sessions/use-session-search.ts";
import type { useLayout } from "./use-layout.ts";

export interface SidebarView extends WorkspaceSelectionView {
	sessionAction: Send<Extract<GuiAction, { action: "new" | "reload" }>>;
	setPanel: (panel: GuiPanel | undefined) => void;
	setError: (error: unknown) => void;
	canSubmit: boolean;
	canChangeSession: boolean;
	usageLoading: boolean;
	openUsage: (mobile: boolean) => Promise<void>;
	workspaceMissing: boolean;
	sessionRows: SessionListItem[];
	sessions: GuiSessionInfo[] | undefined;
	sessionsLoading: boolean;
	refreshSessions: () => Promise<void>;
	workbench: WorkbenchView;
	sessionSearch: SessionSearchView;
	layout: ReturnType<typeof useLayout>;
	openFile: (path: string) => void;
	referenceFile: (path: string) => boolean;
}
