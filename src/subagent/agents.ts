import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { collectAncestorDirs, isPathInside, safeRealpath, uniqueResolvedPaths } from "../resource-paths.js";
import type { AgentDefinition, AgentDiscovery, SubagentConfig, SubagentSource } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "subagent"]);

/** 发现用户级 Agent，并在用户配置允许时发现最近项目根目录下的 Agent。 */
export function discoverAgents(cwd: string, config: SubagentConfig): AgentDiscovery {
	const warnings: string[] = [];
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const userAgentsHomeDir = path.join(os.homedir(), ".agents", "agents");
	const userAgentsDirs = uniqueResolvedPaths([userAgentsDir, userAgentsHomeDir]);
	const projectAgentsDirs = config.allowProjectAgents
		? uniqueResolvedPaths([...findProjectPiAgentsDirs(cwd), ...collectAncestorDirs(cwd, ".agents", "agents")])
			.filter((dir) => path.resolve(dir) !== path.resolve(userAgentsHomeDir))
		: [];
	const userAgents = userAgentsDirs.flatMap((dir) => loadAgentsFromDir(dir, "user", config, warnings, undefined));
	const projectAgents = projectAgentsDirs.flatMap((dir) => loadAgentsFromDir(dir, "project", config, warnings, dir));

	const byName = new Map<string, AgentDefinition>();
	for (const agent of userAgents) {
		if (byName.has(agent.name)) {
			warnings.push(`Duplicate user agent ignored: ${agent.name} (${agent.filePath})`);
			continue;
		}
		byName.set(agent.name, agent);
	}
	for (const agent of projectAgents) {
		if (!byName.has(agent.name)) {
			byName.set(agent.name, agent);
			continue;
		}
		if (config.projectAgentsOverrideUser) {
			warnings.push(`Project agent overrides user agent: ${agent.name} (${agent.filePath})`);
			byName.set(agent.name, agent);
		} else {
			warnings.push(`Duplicate project agent ignored: ${agent.name} (${agent.filePath})`);
		}
	}
	return {
		agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
		warnings,
	};
}

export function hasWriteCapability(tools: string[]): boolean {
	return tools.some((tool) => !READ_ONLY_TOOLS.has(tool));
}

/** 解析 Agent 实际可用工具：配置工具与 Pi 已注册工具的交集，不受主 Agent active tools 限制。 */
export function resolveSubagentTools(
	agent: AgentDefinition,
	config: SubagentConfig,
	registeredTools: string[],
): string[] {
	const configured = config.agentOverrides[agent.name]?.tools ?? agent.tools;
	const registeredSet = new Set(registeredTools);
	return configured.filter((tool) => tool !== "subagent" && registeredSet.has(tool));
}

function loadAgentsFromDir(
	dir: string,
	source: SubagentSource,
	config: SubagentConfig,
	warnings: string[],
	containmentRoot: string | undefined,
): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		warnings.push(`Cannot read agents directory: ${dir}: ${errorMessage(error)}`);
		return [];
	}

	const rootReal = containmentRoot === undefined ? undefined : safeRealpath(containmentRoot);
	if (containmentRoot !== undefined && rootReal === undefined) {
		warnings.push(`Cannot resolve project agents directory: ${containmentRoot}`);
		return [];
	}

	const agents: AgentDefinition[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (rootReal !== undefined) {
			const real = safeRealpath(filePath);
			if (real === undefined || !isPathInside(real, rootReal)) {
				warnings.push(`Project agent rejected outside project .pi/agents: ${filePath}`);
				continue;
			}
		}
		try {
			agents.push(parseAgentFile(filePath, source, config, warnings));
		} catch (error) {
			warnings.push(`${filePath}: ${errorMessage(error)}`);
		}
	}
	return agents;
}

function parseAgentFile(filePath: string, source: SubagentSource, config: SubagentConfig, warnings: string[]): AgentDefinition {
	const content = readFileSync(filePath, "utf8");
	const parsed = parseFrontmatter<Record<string, unknown>>(content);
	const frontmatter: unknown = parsed.frontmatter;
	if (!isRecord(frontmatter)) throw new Error("frontmatter must be an object.");
	const known = new Set(["name", "description", "fork", "model", "tools", "timeout_ms", "auto_confirm"]);
	for (const key of Object.keys(frontmatter)) {
		if (!known.has(key)) warnings.push(`${filePath}: ignored unknown frontmatter field "${key}"`);
	}
	const tools = parseTools(frontmatter["tools"], config.defaultTools, filePath);
	const fork = parseFork(frontmatter["fork"]);
	const model = optionalString(frontmatter["model"], "model");
	const timeoutMs = optionalTimeout(frontmatter["timeout_ms"]);
	const autoConfirm = optionalBoolean(frontmatter["auto_confirm"], "auto_confirm");
	return {
		name: requireString(frontmatter["name"], "name"),
		description: requireString(frontmatter["description"], "description"),
		body: parsed.body,
		fork,
		...(model !== undefined ? { model } : {}),
		tools,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(autoConfirm !== undefined ? { autoConfirm } : {}),
		source,
		filePath,
	};
}

function parseTools(value: unknown, defaults: string[], filePath: string): string[] {
	if (value === undefined) return [...defaults];
	if (typeof value !== "string") throw new Error("tools must be a comma-separated string.");
	const tools = value.split(",").map((item) => item.trim());
	if (tools.length === 0 || tools.some((tool) => tool === "")) throw new Error("tools must not be empty.");
	if (tools.includes("subagent")) throw new Error("tools must not include subagent.");
	if (tools.some((tool) => /\s/.test(tool))) throw new Error(`tools contains an invalid name in ${filePath}.`);
	if (new Set(tools).size !== tools.length) throw new Error("tools must not contain duplicates.");
	return tools;
}

function findNearestProjectAgentsDir(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findProjectPiAgentsDirs(cwd: string): string[] {
	const nearest = findNearestProjectAgentsDir(cwd);
	return nearest === undefined ? [] : [nearest];
}

function isDirectory(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	throw new Error(`${field} must be a non-empty string.`);
}

function requireString(value: unknown, field: string): string {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	throw new Error(`${field} is required.`);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	throw new Error(`${field} must be a boolean.`);
}

function parseFork(value: unknown): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	throw new Error("fork must be a boolean.");
}

function optionalTimeout(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 3_600_000) return value;
	throw new Error("timeout_ms must be an integer between 1000 and 3600000.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
