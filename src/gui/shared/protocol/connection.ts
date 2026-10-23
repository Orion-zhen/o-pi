import { Type, type Static } from "typebox";
import { object, short } from "./schema.ts";
import type { GuiAction, GuiActionResult } from "./actions.ts";
import type { GuiQuery, GuiQueryResults } from "./queries.ts";
import type { GuiEvent } from "./events.ts";

const attentionSchema = object({
	sessionId: Type.Union([short, Type.Null()]),
	focused: Type.Boolean(),
	destination: Type.Union([short, Type.Null()]),
});
export type GuiAttention = Static<typeof attentionSchema>;
export const controlSchema = Type.Union([
	object({ kind: Type.Literal("ack"), id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
	object({ kind: Type.Literal("attention"), value: attentionSchema }),
]);
export type GuiControl = Static<typeof controlSchema>;

export const requestSchema = object({ sessionId: Type.Union([short, Type.Null()]), value: Type.Unknown() });
export type GuiRequest = Static<typeof requestSchema>;

export interface GuiConnection {
	attend(sessionId: string | null): void;
	send<A extends GuiAction>(action: A, sessionId: string | null): Promise<GuiActionResult<A>>;
	query<Q extends GuiQuery>(query: Q, sessionId: string | null): Promise<GuiQueryResults[Q["query"]]>;
	subscribe(listener: (event: GuiEvent) => void): () => void;
	close(): void;
}
