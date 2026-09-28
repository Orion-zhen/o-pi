import type { RefObject } from "react";
import type { GlobalQuery, GuiPanel, GuiSessionInfo, GuiSnapshot, GuiWorkspaceInfo, Query } from "../contract.ts";
import type { GuiMessage } from "../messages.ts";
import type { Send } from "./connection.ts";
import type { SessionActivity } from "./use-session-activity.ts";
import type { SessionListItem } from "./session-list.ts";
import type { WorkbenchView } from "./use-workbench.ts";
import type { useLayout } from "./use-layout.ts";

export interface SessionSnapshot extends GuiSnapshot { messages: GuiMessage[] }
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
	referenceFile: (path: string) => void;
	error: string;
}
