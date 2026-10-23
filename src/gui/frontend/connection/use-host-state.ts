import { useReducer } from "react";
import type { GuiDialog, GuiNotice, GuiSessionActivity, GuiSessionInfo, GuiSnapshot, GuiWorkspaceInfo } from "../../shared/protocol/state.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";

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
		case "sessionsDeleted": {
			const ids = new Set(event.ids), paths = new Set(event.paths);
			return { ...state,
				activities: state.activities.filter((item) => !ids.has(item.sessionId)),
				sessions: state.sessions?.filter((item) => !paths.has(item.path)),
				snapshot: state.snapshot && ids.has(state.snapshot.sessionId) ? null : state.snapshot,
			};
		}
		default: return state;
	}
}

export function useHostState() { return useReducer(reduce, initial); }
