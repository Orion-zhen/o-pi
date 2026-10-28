import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeMcpFixture(directory: string, options: { resources?: boolean; resourceOnly?: boolean } = {}): Promise<string> {
	const file = path.join(directory, "mcp-fixture.mjs");
	await writeFile(file, `
		import { createInterface } from "node:readline";
		const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
		let generation = 0;
		for await (const line of createInterface({ input: process.stdin })) {
			const request = JSON.parse(line);
			if (!("id" in request)) continue;
			let result;
			switch (request.method) {
				case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: ${JSON.stringify({ ...options.resourceOnly ? {} : { tools: { listChanged: true } }, ...options.resources || options.resourceOnly ? { resources: {} } : {} })}, serverInfo: { name: "fixture", version: "1" }, instructions: "MCP_VISIBILITY_NAMESPACE" }; break;
				case "ping": result = {}; break;
				case "tools/list": generation++; result = { tools: (generation > 1 ? ["probe", "refresh", "extra"] : ["probe", "refresh"]).map(name => ({ name, description: "MCP_VISIBILITY_" + name + " " + generation, inputSchema: { type: "object", properties: {} } })) }; break;
				case "tools/call":
					if (request.params.name === "refresh") send({ method: "notifications/tools/list_changed" });
					result = { content: [{ type: "text", text: "MCP_RESULT_" + request.params.name }] }; break;
				case "resources/list": result = { resources: [{ uri: "fixture://document", name: "Fixture document" }] }; break;
				case "resources/templates/list": result = { resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "Fixture template" }] }; break;
				case "resources/read": result = { contents: [{ uri: request.params.uri, text: "RESOURCE_RESULT" }] }; break;
				default: throw new Error(request.method);
			}
			send({ id: request.id, result });
		}
	`);
	return file;
}
