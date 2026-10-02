import { useReducer } from "react";
import type { GuiDialog, GuiEvent, GuiNotice, GuiSessionActivity, GuiSessionInfo, GuiSnapshot, GuiWorkspaceInfo } from "../../contract.ts";

interface HostState {
	navigation: Extract<GuiEvent, { type: "selected" }>["session"];
	snapshot: GuiSnapshot | null;
	activities: GuiSessionActivity[];
	sessions: GuiSessionInfo[] | undefined;
	dialogs: GuiDialog[];
	notices: GuiNotice[];
	workspaceRoot: string;
	workspaces: GuiWorkspaceInfo[];
	stats: Extract<GuiEvent, { type: "sessionStats" }> | undefined;
	telemetry: Extract<GuiEvent, { type: "telemetry" }> | undefined;
}
const initial: HostState = { navigation: null, snapshot: null, activities: [], sessions: undefined, dialogs: [], notices: [],
	workspaceRoot: "", workspaces: [], stats: undefined, telemetry: undefined };

function reduce(state: HostState, event: GuiEvent): HostState {
	switch (event.type) {
		case "selected": return { ...state, navigation: event.session };
		case "snapshot": return { ...state, snapshot: event.value };
		case "activity": return { ...state, activities: event.value };
		case "sessions": return { ...state, sessions: event.value };
		case "dialogs": return { ...state, dialogs: event.value };
		case "notices": return { ...state, notices: event.value };
		case "workspaceRoot": return { ...state, workspaceRoot: event.path };
		case "workspaces": return { ...state, workspaces: event.value };
		case "sessionStats": return { ...state, stats: event };
		case "telemetry": return { ...state, telemetry: event };
		case "sessionsDeleted": return { ...state,
			activities: state.activities.filter((item) => !event.ids.includes(item.sessionId)),
			sessions: state.sessions?.filter((item) => !event.paths.includes(item.path)),
			snapshot: state.snapshot && event.ids.includes(state.snapshot.sessionId) ? null : state.snapshot,
		};
		default: return state;
	}
}

export function useHostState() { return useReducer(reduce, initial); }
