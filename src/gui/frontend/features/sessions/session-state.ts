import type { Send } from "@/connection/connection.ts";
import type { GuiAction, GuiActionResult } from "../../../shared/protocol/actions.ts";
import type { GuiEvent } from "../../../shared/protocol/events.ts";
import type { Query } from "../../../shared/protocol/queries.ts";
import type { GuiDialog, GuiNotice, GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { SessionViewState } from "./session-views.ts";

export type SessionState = {
	target: NonNullable<Extract<GuiEvent, { type: "selected" }>["session"]>;
	view: SessionViewState;
	dialogs: GuiDialog[];
	notices: GuiNotice[];
	stats: Extract<GuiEvent, { type: "sessionStats" }>["value"] | undefined;
	telemetry: Extract<GuiEvent, { type: "telemetry" }>["value"] | undefined;
} & ({ state: "loading"; snapshot: null } | { state: "ready"; snapshot: GuiSnapshot });

export type SessionView = SessionState & {
	send: Send;
	query: Query;
	dispatch<A extends GuiAction>(action: A): Promise<GuiActionResult<A>>;
};
export type ReadySession = Extract<SessionView, { state: "ready" }>;
