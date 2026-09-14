import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { applyPersistedToolPruning, PRUNE_STATE } from "../../../src/harness/prune/prune.js";
import { capturePayload, loadProvider } from "../openai-compatible-provider/fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "../openai-compatible-provider/test-support.js";
import { assistant, customEntry, pruneState, restoreState, toolResult, user } from "./fixtures.js";

const temp = useOpenAICompatibleProviderTestSetup();
const toolImage: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	mimeType: "image/png",
};
const userImage: ImageContent = {
	type: "image",
	data: "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
	mimeType: "image/gif",
};

describe("工具图片裁剪与原生 provider 请求转换", () => {
	it.each(["openai-completions", "openai-responses"] as const)("%s 裁剪工具图片、保留用户图片，并支持恢复且不改写历史", async (api) => {
		const provider = await loadProvider(temp.path, { api, models: [{ id: "m", input: ["text", "image"] }] });
		const messages: AgentMessage[] = [
			{ ...user("compare"), content: [{ type: "text", text: "compare" }, userImage] },
			assistant([
				{ type: "toolCall", id: "pdf", name: "read", arguments: { path: "document.pdf" } },
				{ type: "toolCall", id: "image", name: "read", arguments: { path: "image.png" } },
			]),
			{ ...toolResult("pdf", ""), content: [
				{ type: "text", text: '<pdf_page number="1"/>' }, toolImage,
				{ type: "text", text: '<pdf_page number="2"/>' }, toolImage,
			] },
			{ ...toolResult("image", ""), content: [toolImage] },
		];
		const original = structuredClone(messages);
		const request = (entries: SessionEntry[]) => capturePayload(provider, {}, {
			context: { messages: convertToLlm(applyPersistedToolPruning(messages, entries)) },
		});
		const partialEntry = customEntry(PRUNE_STATE, pruneState(["pdf"]), "partial");
		const allEntry = customEntry(PRUNE_STATE, pruneState(["pdf", "image"], ["pdf"]), "all");
		const full = await request([]);
		const partial = await request([partialEntry]);
		const pruned = await request([partialEntry, allEntry]);

		expect(JSON.stringify(full).split(`data:${toolImage.mimeType};base64,${toolImage.data}`)).toHaveLength(4);
		expect(JSON.stringify(partial).split(`data:${toolImage.mimeType};base64,${toolImage.data}`)).toHaveLength(2);
		expect(JSON.stringify(pruned)).not.toContain(toolImage.data);
		for (const payload of [full, partial, pruned]) {
			expect(JSON.stringify(payload).split(`data:${userImage.mimeType};base64,${userImage.data}`)).toHaveLength(2);
		}

		if (api === "openai-completions") {
			expect(full).toMatchObject({ messages: [
				{ role: "user" }, { role: "assistant" },
				{ role: "tool", tool_call_id: "pdf", content: expect.any(String) },
				{ role: "tool", tool_call_id: "image", content: expect.any(String) },
				{ role: "user", content: [
					{ type: "text" }, { type: "image_url" }, { type: "image_url" }, { type: "image_url" },
				] },
			] });
			expect(partial).toMatchObject({ messages: [
				{ role: "user" }, { role: "assistant" },
				{ role: "tool", tool_call_id: "image" },
				{ role: "user", content: [{ type: "text" }, { type: "image_url" }] },
			] });
			expect(pruned).toMatchObject({ messages: [{ role: "user" }] });
		} else {
			expect(full).toMatchObject({ input: [
				{ role: "user" },
				{ type: "function_call", call_id: "pdf" },
				{ type: "function_call", call_id: "image" },
				{ type: "function_call_output", call_id: "pdf", output: [
					{ type: "input_text" }, { type: "input_image" }, { type: "input_image" },
				] },
				{ type: "function_call_output", call_id: "image", output: [{ type: "input_image" }] },
			] });
			expect(pruned).toMatchObject({ input: [{ role: "user" }] });
		}

		const restored = await request([
			partialEntry, allEntry,
			customEntry(PRUNE_STATE, restoreState(["pdf"], "all"), "restore-all"),
		]);
		expect(restored).toEqual(partial);
		expect(messages).toEqual(original);
	});
});
