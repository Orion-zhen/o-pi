import { mcpDuplicateKeys, mcpNameConflict, mcpObject, parseMcpConfig, validateMcpServer, type McpConfig, type McpIssue, type McpObject } from "../../mcp-validation.ts";

export const mcpMapFields = ["env", "headers", "toolExposure"] as const;
export type McpMapField = typeof mcpMapFields[number];
export type McpAuthMode = "auto" | "bearer" | "headers" | "provider";
export type McpPair = { id: number; key: string; value: unknown };
export type McpArgument = { id: number; value: unknown };
export interface McpServerDraft {
	id: number;
	name: string;
	config: unknown;
	authMode: McpAuthMode;
	args?: McpArgument[];
	maps: Partial<Record<McpMapField, McpPair[]>>;
}
export interface McpDraft { root: McpObject; servers: McpServerDraft[] }

let nextId = 0;
export function mcpId(): number { return nextId++; }

export function createMcpServer(name: string, value: unknown): McpServerDraft {
	const id = mcpId();
	if (!mcpObject(value)) return { id, name, config: value, authMode: "auto", maps: {} };
	const config = { ...value };
	const maps: McpServerDraft["maps"] = {};
	for (const field of mcpMapFields) if (mcpObject(config[field])) {
		maps[field] = Object.entries(config[field]).map(([key, value]) => ({ id: mcpId(), key, value }));
		delete config[field];
	}
	const args = Array.isArray(config.args) ? config.args.map((value: unknown) => ({ id: mcpId(), value })) : undefined;
	if (args) delete config.args;
	const authorization = maps.headers?.find((row) => row.key.toLowerCase() === "authorization");
	const bearer = typeof authorization?.value === "string" && authorization.value.startsWith("Bearer ");
	const authMode = config.auth !== undefined ? "provider" : bearer ? "bearer" : maps.headers?.length ? "headers" : "auto";
	return { id, name, config, authMode, maps, ...(args ? { args } : {}) };
}

export function copyMcpServer(server: McpServerDraft, name: string): McpServerDraft {
	return {
		...server, id: mcpId(), name,
		...(server.args ? { args: server.args.map((arg) => ({ ...arg, id: mcpId() })) } : {}),
		maps: Object.fromEntries(Object.entries(server.maps).map(([field, rows]) => [field, rows.map((row) => ({ ...row, id: mcpId() }))])),
	};
}

export function createMcpDraft({ mcpServers, ...root }: McpConfig): McpDraft {
	const servers = Object.entries(mcpServers ?? {}).map(([name, value]) => createMcpServer(name, value));
	return { root, servers };
}

export function mcpServerValue(server: McpServerDraft): unknown {
	if (!mcpObject(server.config)) return server.config;
	const config = { ...server.config };
	if (server.args) config.args = server.args.map(({ value }) => value);
	for (const field of mcpMapFields) {
		const pairs = server.maps[field];
		if (pairs) config[field] = Object.fromEntries(pairs.map(({ key, value }) => [key, value]));
	}
	return config;
}

export function mcpDraftIssues(draft: McpDraft, server: McpServerDraft): McpIssue[] {
	const issues = validateMcpServer(server.name, mcpServerValue(server));
	const conflict = mcpNameConflict(server.name, draft.servers.filter((other) => other.id !== server.id).map(({ name }) => name));
	if (conflict !== undefined) issues.push({ field: "name", message: `与 ${conflict} 名称冲突，- 与 _ 视为相同。` });
	for (const field of mcpMapFields) {
		if (mcpDuplicateKeys((server.maps[field] ?? []).map(({ key }) => key))) issues.push({ field, message: "名称不能重复。" });
	}
	return issues;
}

/** 重复键属于编辑中间态，不能静默转换成 JSON 对象。 */
export function mcpDraftSerializable(draft: McpDraft): boolean {
	return !mcpDuplicateKeys(draft.servers.map(({ name }) => name))
		&& draft.servers.every((server) => Object.values(server.maps).every((rows) => !mcpDuplicateKeys(rows.map(({ key }) => key))));
}

export function writeMcpDraft(draft: McpDraft): string {
	const mcpServers = Object.fromEntries(draft.servers.map((server) => [server.name, mcpServerValue(server)]));
	return `${JSON.stringify({ ...draft.root, mcpServers }, null, 2)}\n`;
}

export function nextMcpName(draft: McpDraft, base = "new-server"): string {
	const names = draft.servers.map(({ name }) => name);
	let name = base;
	for (let index = 2; mcpNameConflict(name, names) !== undefined; index++) name = `${base}-${index}`;
	return name;
}

export function importMcpServers(content: string): McpServerDraft[] {
	const value = parseMcpConfig(content);
	if (value.mcpServers !== undefined) {
		const draft = createMcpDraft(value);
		if (!draft.servers.length) throw new Error("配置中没有服务。");
		return draft.servers;
	}
	if ("command" in value || "url" in value) return [createMcpServer("new-server", value)];
	throw new Error("未找到 mcpServers、command 或 url。");
}

/** 切换连接方式时只删除另一种连接专属字段，保留通用和未知字段。 */
export function changeMcpTransport(server: McpServerDraft & { config: McpObject }, remote: boolean): McpServerDraft {
	const config: McpObject = { ...server.config, type: remote ? "http" : "stdio" };
	const maps = { ...server.maps };
	for (const field of remote ? ["command", "args", "env", "cwd"] : ["url", "headers", "auth", "oauth"]) delete config[field];
	if (remote) {
		delete maps.env;
		const next = { ...server, config: { ...config, url: "" }, maps, authMode: "auto" as const };
		delete next.args;
		return next;
	}
	delete maps.headers;
	return { ...server, config: { ...config, command: "" }, maps, authMode: "auto" };
}

export function mcpServerSummary(server: McpServerDraft): string {
	const config = mcpServerValue(server);
	if (!mcpObject(config)) return "配置需要修复";
	if (typeof config.url === "string") return URL.canParse(config.url) ? new URL(config.url).host : "未填写有效地址";
	// 参数可能包含密钥，摘要只显示程序，不显示参数和 URL 路径。
	return typeof config.command === "string" && config.command ? config.command : "未填写启动程序";
}
