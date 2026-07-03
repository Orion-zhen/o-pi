import type { ComponentCatalogEntry, ComponentRegistry } from "../analysis/component-registry.js";
import { digest } from "../model/digest.js";

export interface VisibleCatalogEntry {
	name: string;
	displayName: string;
	description?: string;
	available: boolean;
	identityDigest: string;
}

export interface VisibleToolEntry extends VisibleCatalogEntry {
	kind: "tool" | "bash";
}

export interface VisibleMcpToolEntry extends VisibleCatalogEntry {}

export interface VisibleMcpServerEntry extends VisibleCatalogEntry {
	tools: VisibleMcpToolEntry[];
}

export interface VisibleSkillEntry extends VisibleCatalogEntry {}

export interface VisibleAgentEntry extends VisibleCatalogEntry {}

export interface PermissionCatalog {
	tools: VisibleToolEntry[];
	mcpServers: VisibleMcpServerEntry[];
	skills: VisibleSkillEntry[];
	agents: VisibleAgentEntry[];
}

/** 用户配置名称只从 catalog 解析；identityDigest 仅用于内部失效和高级调试。 */
export function buildPermissionCatalog(registry: ComponentRegistry): PermissionCatalog {
	const entries = registry.catalog();
	return {
		tools: [...toolEntries(entries), builtinMainToolFallback(entries)].filter((entry): entry is VisibleToolEntry => entry !== undefined).sort(byName),
		mcpServers: mcpServerEntries(entries).sort(byName),
		skills: entries.filter((entry) => entry.identity.kind === "skill").map((entry) => visibleEntry(entry)).sort(byName),
		agents: agentEntries(entries).sort(byName),
	};
}

export function formatCatalog(catalog: PermissionCatalog): string {
	const lines = [
		"Tools",
		...catalog.tools.filter((entry) => entry.available).map((entry) => `  ${entry.name}`),
		"",
		"MCP",
		...catalog.mcpServers.flatMap((server) => server.tools.filter((tool) => server.available && tool.available).map((tool) => `  ${server.name}/${tool.name}`)),
		"",
		"Skills",
		...catalog.skills.filter((entry) => entry.available).map((entry) => `  ${entry.name}`),
		"",
		"Agents",
		...catalog.agents.filter((entry) => entry.available).map((entry) => `  ${entry.name}`),
	];
	return lines.join("\n");
}

function toolEntries(entries: readonly ComponentCatalogEntry[]): VisibleToolEntry[] {
	return entries
		.filter((entry) => entry.identity.kind === "tool" || entry.identity.kind === "bash")
		.map((entry) => ({
			...visibleEntry(entry),
			name: entry.identity.kind === "bash" ? "bash" : entry.identity.displayName,
			kind: entry.identity.kind === "bash" ? "bash" as const : "tool" as const,
		}));
}

function mcpServerEntries(entries: readonly ComponentCatalogEntry[]): VisibleMcpServerEntry[] {
	const byServer = new Map<string, ComponentCatalogEntry[]>();
	for (const entry of entries.filter((candidate) => candidate.identity.kind === "mcp-tool")) {
		const parsed = parseMcpDisplayName(entry.identity.displayName);
		if (parsed === undefined) continue;
		const list = byServer.get(parsed.server) ?? [];
		list.push(entry);
		byServer.set(parsed.server, list);
	}
	return [...byServer.entries()].map(([server, tools]) => {
		const available = tools.every((tool) => !tool.conflict);
		return {
			name: server,
			displayName: server,
			available,
			identityDigest: digest({ kind: "mcp-server", server, tools: tools.map((tool) => tool.identity.id).sort() }),
			tools: tools.map((tool) => ({ ...visibleEntry(tool), name: parseMcpDisplayName(tool.identity.displayName)?.tool ?? tool.identity.displayName })).sort(byName),
		};
	});
}

function agentEntries(entries: readonly ComponentCatalogEntry[]): VisibleAgentEntry[] {
	const fromRegistry = entries.filter((entry) => entry.identity.kind === "agent").map((entry) => visibleEntry(entry));
	if (fromRegistry.some((entry) => entry.name === "main")) return fromRegistry;
	return [
		{
			name: "main",
			displayName: "main",
			available: true,
			identityDigest: digest({ builtin: "agent", name: "main" }),
		},
		...fromRegistry,
	];
}

function builtinMainToolFallback(_entries: readonly ComponentCatalogEntry[]): VisibleToolEntry | undefined {
	return undefined;
}

function visibleEntry(entry: ComponentCatalogEntry): VisibleCatalogEntry {
	return {
		name: entry.identity.displayName,
		displayName: entry.identity.displayName,
		available: entry.active && !entry.conflict,
		identityDigest: digest(entry.identity),
	};
}

function parseMcpDisplayName(displayName: string): { server: string; tool: string } | undefined {
	const [server, tool, extra] = displayName.split("/");
	if (server === undefined || tool === undefined || extra !== undefined || server === "" || tool === "") return undefined;
	return { server, tool };
}

function byName(left: { name: string }, right: { name: string }): number {
	return left.name.localeCompare(right.name);
}
