import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
	messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
	tools?: Array<{ function: { name: string } }>;
}

export type ModelResponse = { text: string } | { tool: string; args: Record<string, unknown> };

/** 模拟模型 HTTP 边界，CLI、Provider、工具和会话全部走正式实现。 */
export async function startModelServer(respond: (request: ModelRequest) => ModelResponse) {
	const requests: ModelRequest[] = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest;
			requests.push(body);
			const reply = respond(body);
			const delta = "tool" in reply
				? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
				: { role: "assistant", content: reply.text };
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const [value, finish] of [[delta, null], [{}, "tool" in reply ? "tool_calls" : "stop"]] as const) {
				response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
			}
			response.end("data: [DONE]\n\n");
		} catch (error) {
			response.writeHead(500).end(String(error));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () => new Promise<void>((resolve, reject) => {
			server.closeAllConnections();
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}
