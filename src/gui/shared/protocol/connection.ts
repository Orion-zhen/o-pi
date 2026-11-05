import { bool, int, lit, nul, union, unknown, type Static } from "@earendil-works/pi-schema";
import { object, short } from "./schema.ts";
import type { GuiAction, GuiActionResult } from "./actions.ts";
import type { GuiQuery, GuiQueryResults } from "./queries.ts";
import type { GuiEvent } from "./events.ts";

const attentionSchema = object({
	focused: bool(),
	destination: union([short, nul()]),
});
export type GuiAttention = Static<typeof attentionSchema>;
export const controlSchema = union([
	object({ kind: lit("ack"), id: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
	object({ kind: lit("attention"), value: attentionSchema }),
]);
export type GuiControl = Static<typeof controlSchema>;

export const requestSchema = object({ sessionId: union([short, nul()]), value: unknown() });
export type GuiRequest = Static<typeof requestSchema>;

export interface GuiConnection {
	send<A extends GuiAction>(action: A, sessionId: string | null): Promise<GuiActionResult<A>>;
	query<Q extends GuiQuery>(query: Q, sessionId: string | null): Promise<GuiQueryResults[Q["query"]]>;
	subscribe(listener: (event: GuiEvent) => void): () => void;
	close(): void;
}
