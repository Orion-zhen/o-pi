import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import type { PermissionCatalog } from "../catalog/permission-catalog.js";
import type { UserMcpModeMap, UserModeMap, UserPermissionConfig, UserPermissionSection } from "./user-config.js";

const modeEnum = ["off", "allow", "ask", "always-ask"] as const;

export const forbiddenUserConfigTokens = new Set([
	"fs.read",
	"fs.write",
	"tool.invoke",
	"agent.delegate",
	"mcp.tool.invoke",
	"ActionId",
	"ResourceUri",
	"PrincipalPattern",
	"ComponentIdentity",
	"sourceDigest",
	"schemaDigest",
	"manifestDigest",
	"policyDigest",
	"delegationDigest",
	"internal component ID",
	"principalPattern",
	"resourceUri",
	"actionPatterns",
	"resourcePatterns",
	"componentIdentityDigest",
]);

export const userPermissionConfigSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://pi.local/permissions.schema.json",
	type: "object",
	additionalProperties: false,
	required: ["version"],
	properties: {
		$schema: { type: "string" },
		version: { const: 1 },
		global: { $ref: "#/$defs/section" },
		agents: { type: "object", additionalProperties: { $ref: "#/$defs/section" } },
		paths: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["agents"],
				anyOf: [{ required: ["match"] }, { required: ["outsideWorkspace"] }],
				not: { required: ["match", "outsideWorkspace"] },
				properties: {
					match: { type: "string", minLength: 1 },
					outsideWorkspace: { const: true },
					agents: { type: "object", minProperties: 1, additionalProperties: { $ref: "#/$defs/section" } },
				},
			},
		},
		approval: {
			type: "object",
			additionalProperties: false,
			properties: {
				ask: {
					type: "object",
					additionalProperties: false,
					properties: { remember: { type: "array", items: { enum: ["once", "session", "persistent"] }, uniqueItems: true } },
				},
				"always-ask": {
					type: "object",
					additionalProperties: false,
					properties: { remember: { type: "array", items: { const: "once" }, uniqueItems: true, maxItems: 1 } },
				},
			},
		},
		audit: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } },
	},
	$defs: {
		mode: { enum: modeEnum },
		modeMap: {
			type: "object",
			additionalProperties: { $ref: "#/$defs/mode" },
		},
		mcpMap: {
			type: "object",
			additionalProperties: {
				anyOf: [{ $ref: "#/$defs/mode" }, { $ref: "#/$defs/modeMap" }],
			},
		},
		section: {
			type: "object",
			additionalProperties: false,
			properties: {
				tools: { $ref: "#/$defs/modeMap" },
				mcp: { $ref: "#/$defs/mcpMap" },
				skills: { $ref: "#/$defs/modeMap" },
				subagents: { $ref: "#/$defs/modeMap" },
			},
		},
	},
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(userPermissionConfigSchema);

export function validateUserPermissionShape(value: unknown): string[] {
	if (validate(value)) return [];
	return (validate.errors ?? []).map(ajvMessage);
}

export function validateUserPermissionSemantics(config: UserPermissionConfig, catalog: PermissionCatalog): string[] {
	const diagnostics = [...findForbiddenTokens(config)];
	const catalogIndex = buildCatalogIndex(catalog);
	validateSection(config.global, catalogIndex, "global", diagnostics);
	for (const [agentName, section] of Object.entries(config.agents ?? {})) {
		validateName("Agent", agentName, catalogIndex.agents, diagnostics);
		validateSection(section, catalogIndex, `agent ${agentName}`, diagnostics);
	}
	for (const [index, rule] of (config.paths ?? []).entries()) {
		for (const [agentName, section] of Object.entries(rule.agents)) {
			if (agentName !== "*") validateName("Agent", agentName, catalogIndex.agents, diagnostics);
			validateSection(section, catalogIndex, `path ${index} agent ${agentName}`, diagnostics);
		}
	}
	return diagnostics;
}

export function generateCatalogSchema(catalog: PermissionCatalog): unknown {
	const toolNames = [...names(catalog.tools), "*"];
	const skillNames = [...names(catalog.skills), "*"];
	const agentNames = [...names(catalog.agents), "*"];
	const mcpServerNames = [...catalog.mcpServers.map((server) => server.name), "*"];
	const mcpToolDefs = Object.fromEntries(
		catalog.mcpServers.map((server) => [
			server.name,
			{
				type: "object",
				additionalProperties: false,
				properties: Object.fromEntries([...server.tools.map((tool) => tool.name), "*"].map((name) => [name, { enum: modeEnum }])),
			},
		]),
	);
	return {
		...userPermissionConfigSchema,
		$defs: {
			...userPermissionConfigSchema.$defs,
			toolModeMap: namedModeMap(toolNames),
			skillModeMap: namedModeMap(skillNames),
			subagentModeMap: namedModeMap(agentNames),
			mcpMap: {
				type: "object",
				additionalProperties: false,
				properties: Object.fromEntries(mcpServerNames.map((name) => [name, name === "*" ? { enum: modeEnum } : mcpToolDefs[name] ?? { enum: modeEnum }])),
			},
			section: {
				type: "object",
				additionalProperties: false,
				properties: {
					tools: { $ref: "#/$defs/toolModeMap" },
					mcp: { $ref: "#/$defs/mcpMap" },
					skills: { $ref: "#/$defs/skillModeMap" },
					subagents: { $ref: "#/$defs/subagentModeMap" },
				},
			},
		},
	};
}

interface CatalogIndex {
	tools: ReadonlyMap<string, boolean>;
	skills: ReadonlyMap<string, boolean>;
	agents: ReadonlyMap<string, boolean>;
	mcpServers: ReadonlyMap<string, { available: boolean; tools: ReadonlyMap<string, boolean> }>;
}

function buildCatalogIndex(catalog: PermissionCatalog): CatalogIndex {
	return {
		tools: entryMap(catalog.tools),
		skills: entryMap(catalog.skills),
		agents: entryMap(catalog.agents),
		mcpServers: new Map(catalog.mcpServers.map((server) => [server.name, { available: server.available, tools: entryMap(server.tools) }])),
	};
}

function validateSection(section: UserPermissionSection | undefined, catalog: CatalogIndex, where: string, diagnostics: string[]): void {
	if (section === undefined) return;
	validateModeMap("tool", section.tools, catalog.tools, where, diagnostics);
	validateModeMap("Skill", section.skills, catalog.skills, where, diagnostics);
	validateModeMap("Agent", section.subagents, catalog.agents, where, diagnostics);
	validateMcpMap(section.mcp, catalog, where, diagnostics);
}

function validateModeMap(label: string, map: UserModeMap | undefined, allowed: ReadonlyMap<string, boolean>, where: string, diagnostics: string[]): void {
	for (const name of Object.keys(map ?? {})) {
		if (name === "*") continue;
		validateName(label, name, allowed, diagnostics, where);
	}
}

function validateMcpMap(map: UserMcpModeMap | undefined, catalog: CatalogIndex, where: string, diagnostics: string[]): void {
	for (const [serverName, serverValue] of Object.entries(map ?? {})) {
		if (serverName === "*") continue;
		const server = catalog.mcpServers.get(serverName);
		if (server === undefined) {
			diagnostics.push(unknownMessage("MCP server", serverName, [...catalog.mcpServers.keys()], where));
			continue;
		}
		if (!server.available) {
			diagnostics.push(`MCP server "${serverName}" has a catalog identity conflict and cannot be configured.`);
			continue;
		}
		if (typeof serverValue === "string") continue;
		validateModeMap("MCP tool", serverValue, server.tools, `${where} MCP ${serverName}`, diagnostics);
	}
}

function validateName(label: string, name: string, allowed: ReadonlyMap<string, boolean>, diagnostics: string[], where?: string): void {
	const available = allowed.get(name);
	if (available === true) return;
	if (available === false) {
		diagnostics.push(`${label} "${name}" has a catalog identity conflict and cannot be configured.`);
		return;
	}
	diagnostics.push(unknownMessage(label, name, [...allowed.keys()], where));
}

function unknownMessage(label: string, name: string, candidates: readonly string[], where?: string): string {
	const prefix = where === undefined ? "" : `${where}: `;
	const suggestion = suggest(name, candidates);
	return `${prefix}Unknown ${label} "${name}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`;
}

function suggest(name: string, candidates: readonly string[]): string | undefined {
	let best: { candidate: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = levenshtein(name, candidate);
		if (best === undefined || distance < best.distance) best = { candidate, distance };
	}
	return best !== undefined && best.distance <= Math.max(2, Math.floor(name.length / 2)) ? best.candidate : undefined;
}

function levenshtein(left: string, right: string): number {
	const row = Array.from({ length: right.length + 1 }, (_value, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		let previous = row[0]!;
		row[0] = i;
		for (let j = 1; j <= right.length; j += 1) {
			const old = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
			previous = old;
		}
	}
	return row[right.length]!;
}

function findForbiddenTokens(value: unknown, path: string[] = []): string[] {
	const diagnostics: string[] = [];
	if (typeof value === "string" && forbiddenUserConfigTokens.has(value)) {
		diagnostics.push(`User permission config cannot contain internal token "${value}" at ${path.join(".") || "$"}.`);
		return diagnostics;
	}
	if (typeof value !== "object" || value === null) return diagnostics;
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) diagnostics.push(...findForbiddenTokens(item, [...path, String(index)]));
		return diagnostics;
	}
	for (const [key, item] of Object.entries(value)) {
		if (forbiddenUserConfigTokens.has(key) || /digest/i.test(key)) {
			diagnostics.push(`User permission config cannot contain internal field "${key}" at ${path.join(".") || "$"}.`);
		}
		diagnostics.push(...findForbiddenTokens(item, [...path, key]));
	}
	return diagnostics;
}

function entryMap(entries: readonly { name: string; available: boolean }[]): ReadonlyMap<string, boolean> {
	return new Map(entries.map((entry) => [entry.name, entry.available]));
}

function names(entries: readonly { name: string; available: boolean }[]): string[] {
	return entries.filter((entry) => entry.available).map((entry) => entry.name);
}

function namedModeMap(propertyNames: readonly string[]): unknown {
	return {
		type: "object",
		additionalProperties: false,
		properties: Object.fromEntries(propertyNames.map((name) => [name, { enum: modeEnum }])),
	};
}

function ajvMessage(error: ErrorObject): string {
	if (error.keyword === "additionalProperties" && "additionalProperty" in error.params) {
		return `Unknown property "${String(error.params.additionalProperty)}".`;
	}
	if (error.instancePath.length > 0) return `${error.instancePath}: ${error.message ?? "Schema validation failed."}`;
	return error.message ?? "Schema validation failed.";
}
