import type { GuiClient } from "../../src/gui/host/client.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { locateTranscript } from "../../src/gui/ui/transcript-location.ts";

export function readSnapshot(client: GuiClient) {
	const events: GuiEvent[] = [];
	client.replay((event) => events.push(event));
	const snapshot = events.findLast((event) => event.type === "snapshot")?.value;
	if (!snapshot) throw new Error("会话尚未就绪");
	return { ...snapshot, messages: locateTranscript(snapshot, undefined).messages };
}
