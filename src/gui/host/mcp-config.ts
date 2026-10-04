import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNotFound } from "../../harness/config-loader.ts";
import { replaceConfigFile } from "./files.ts";
import type { McpConfigDocument } from "../mcp.ts";
import { parseMcpConfig, validateMcpConfig } from "../mcp-validation.ts";

export async function readMcpConfig(): Promise<McpConfigDocument> {
	const file = path.join(getAgentDir(), "mcp.json");
	let content: string;
	try { content = await readFile(file, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	return { path: file, content };
}

export async function saveMcpConfig(original: string, content: string): Promise<void> {
	const errors = validateMcpConfig(parseMcpConfig(content));
	if (errors.length) throw new Error(errors.join("\n"));
	await replaceConfigFile(path.join(getAgentDir(), "mcp.json"), original, content);
}
