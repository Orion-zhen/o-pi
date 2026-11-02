import { useState, useSyncExternalStore } from "react";
import type { GuiDialog, GuiNotice, GuiSessionActivity, GuiSessionInfo, GuiSnapshot, GuiWorkspaceInfo } from "../../shared/protocol/state.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import { SessionViews, type SessionViewState } from "@/features/sessions/session-views.ts";

type SelectedSession = NonNullable<Extract<GuiEvent, { type: "selected" }>["session"]>;
type SessionState = {
	target: SelectedSession;
	view: SessionViewState;
	dialogs: GuiDialog[];
	notices: GuiNotice[];
	stats: Extract<GuiEvent, { type: "sessionStats" }>["value"] | undefined;
	telemetry: Extract<GuiEvent, { type: "telemetry" }>["value"] | undefined;
} & ({ state: "loading"; snapshot: null } | { state: "ready"; snapshot: GuiSnapshot });
interface HostState {
	selection: SessionState | null;
	activities: GuiSessionActivity[];
	sessions: GuiSessionInfo[] | undefined;
	workspaceRoot: string;
	workspaces: GuiWorkspaceInfo[];
}

/** 在事件入口确定归属，下游只读取当前会话的数据。 */
class HostStore {
	readonly views = new SessionViews();
	private state: HostState = { selection: null, activities: [], sessions: undefined, workspaceRoot: "", workspaces: [] };
	private listeners = new Set<() => void>();
	read = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	receive = (event: GuiEvent) => {
		const state = this.state;
		const selected = state.selection;
		switch (event.type) {
			case "selected":
				this.state = { ...state, selection: event.session ? {
					state: "loading", target: event.session, view: this.views.open(event.session, event.draftFrom), snapshot: null,
					dialogs: [], notices: [], stats: undefined, telemetry: undefined,
				} : null };
				break;
			case "snapshot":
				if (!selected || event.value !== null && event.value.sessionId !== selected.target.id) return;
				this.state = { ...state, selection: event.value
					? { ...selected, state: "ready", snapshot: event.value }
					: { ...selected, state: "loading", snapshot: null } };
				break;
			case "sessionStats":
			case "telemetry":
				if (!selected || event.sessionId !== selected.target.id) return;
				this.state = { ...state, selection: event.type === "sessionStats" ? { ...selected, stats: event.value } : { ...selected, telemetry: event.value } };
				break;
			case "dialogs":
			case "notices":
				if (!selected) return;
				this.state = { ...state, selection: event.type === "dialogs" ? { ...selected, dialogs: event.value } : { ...selected, notices: event.value } };
				break;
			case "activity": this.state = { ...state, activities: event.value }; break;
			case "sessions": this.state = { ...state, sessions: event.value }; break;
			case "workspaceRoot": this.state = { ...state, workspaceRoot: event.path }; break;
			case "workspaces": this.state = { ...state, workspaces: event.value }; break;
			case "sessionsDeleted": {
				const ids = new Set(event.ids), paths = new Set(event.paths);
				this.state = { ...state,
					activities: state.activities.filter((item) => !ids.has(item.sessionId)),
					sessions: state.sessions?.filter((item) => !paths.has(item.path)),
					selection: selected && (ids.has(selected.target.id) || selected.target.path !== null && paths.has(selected.target.path)) ? null : selected,
				};
				break;
			}
			default: return;
		}
		for (const listener of this.listeners) listener();
	};
}

export function useHostState() {
	const [store] = useState(() => new HostStore());
	const state = useSyncExternalStore(store.subscribe, store.read);
	return { host: state, receive: store.receive, views: store.views, current: store.read };
}
