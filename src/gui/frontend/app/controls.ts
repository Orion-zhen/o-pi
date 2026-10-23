import type { RefObject } from "react";
import type { GlobalQuery, Query } from "../../shared/protocol/queries.ts";
import type { GuiPanel, GuiSessionInfo, GuiWorkspaceInfo } from "../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import type { SessionActivity } from "@/features/sessions/use-session-activity.ts";
import type { SessionListItem } from "@/features/sessions/session-list.ts";
import type { WorkbenchView } from "@/features/workspace/use-workbench.ts";
import type { useLayout } from "./use-layout.ts";

export interface GuiControls {
	send: Send;
	query: Query;
	globalQuery: Query<GlobalQuery>;
	setPanel: (panel: GuiPanel | undefined) => void;
	setError: (message: string) => void;
	connected: boolean;
	canSubmit: boolean;
	canChangeSession: boolean;
	canNavigate: boolean;
}
export interface EditorControls {
	editor: RefObject<HTMLTextAreaElement | null>;
	setDraft: (text: string) => void;
}
export interface SidebarView extends GuiControls {
	usageLoading: boolean;
	openUsage: (mobile: boolean) => Promise<void>;
	cwd: string;
	activity: SessionActivity[];
	sessionRows: SessionListItem[];
	sessions: GuiSessionInfo[] | undefined;
	sessionsLoading: boolean;
	refreshSessions: () => Promise<void>;
	workspaceRoot: string;
	workspaces: GuiWorkspaceInfo[];
	workbench: WorkbenchView;
	layout: ReturnType<typeof useLayout>;
	openFile: (path: string) => void;
	referenceFile: (path: string) => boolean;
	error: string;
}
