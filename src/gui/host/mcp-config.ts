import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNotFound } from "../../harness/config-loader.ts";
import { replaceConfigFile } from "./files.ts";
import type { McpConfigDocument } from "../mcp.ts";

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStructure(content: string): void {
	const value: unknown = JSON.parse(content);
	if (!object(value)) throw new Error("MCP 配置必须是 JSON 对象。");
	if (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== "boolean")
		throw new Error("autoEnableCodemode 必须是布尔值。");
	if (value.mcpServers === undefined) return;
	if (!object(value.mcpServers)) throw new Error("mcpServers 必须是 JSON 对象。");
	for (const [name, config] of Object.entries(value.mcpServers)) {
		if (!object(config)) throw new Error(`MCP 服务 ${name} 的配置必须是 JSON 对象。`);
	}
}

export async function readMcpConfig(): Promise<McpConfigDocument> {
	const file = path.join(getAgentDir(), "mcp.json");
	let content: string;
	try { content = await readFile(file, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	const document: McpConfigDocument = { path: file, content, errors: [] };
	try { if (content !== "") validateStructure(content); }
	catch (error) { document.errors.push(error instanceof Error ? error.message : String(error)); }
	return document;
}

export async function saveMcpConfig(original: string, content: string): Promise<void> {
	if (content.trim().length === 0) throw new Error("MCP 配置不能为空，请使用 {} 清空配置。");
	validateStructure(content);
	await replaceConfigFile(path.join(getAgentDir(), "mcp.json"), original, content);
}
