import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentDiscovery, OutputMode, SubagentConfig, SubagentSource } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** 发现用户级 Agent，并在用户配置允许时发现最近项目根目录下的 Agent。 */
export function discoverAgents(cwd: string, config: SubagentConfig): AgentDiscovery {
	const warnings: string[] = [];
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const userAgentsHomeDir = path.join(os.homedir(), ".agents", "agents");
	const userAgentsDirs = uniquePaths([userAgentsDir, userAgentsHomeDir]);
	const projectAgentsDirs = config.allowProjectAgents
		? uniquePaths([...findProjectPiAgentsDirs(cwd), ...collectAncestorAgentsDirs(cwd)]).filter((dir) => path.resolve(dir) !== path.resolve(userAgentsHomeDir))
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
		userAgentsDir,
		...(projectAgentsDirs[0] !== undefined ? { projectAgentsDir: projectAgentsDirs[0] } : {}),
	};
}

export function formatAvailableAgents(agents: AgentDefinition[]): string {
	if (agents.length === 0) return "none";
	return agents.map((agent) => `${agent.name} (${agent.source})`).join(", ");
}

export function hasWriteCapability(tools: string[]): boolean {
	return tools.some((tool) => !READ_ONLY_TOOLS.has(tool));
}

/** 解析 Agent 实际可用工具：配置工具与 Pi 已注册工具的交集，不受主 Agent active tools 限制。 */
export function resolveSubagentTools(
	agent: AgentDefinition,
	config: SubagentConfig,
	registeredTools: string[] | undefined,
): string[] {
	const override = config.agentOverrides[agent.name];
	const configured = override?.tools ?? agent.tools ?? config.defaultTools;
	const registeredSet = registeredTools === undefined ? undefined : new Set(registeredTools);
	const result: string[] = [];
	for (const tool of configured) {
		if (tool === "subagent") continue;
		if (registeredSet !== undefined && !registeredSet.has(tool)) continue;
		if (!result.includes(tool)) result.push(tool);
	}
	return result;
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
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const known = new Set(["name", "description", "model", "tools", "output_mode", "timeout_ms", "retries"]);
	for (const key of Object.keys(frontmatter)) {
		if (!known.has(key)) warnings.push(`${filePath}: ignored unknown frontmatter field "${key}"`);
	}
	const name = requireString(frontmatter["name"], "name");
	const description = requireString(frontmatter["description"], "description");
	const tools = parseTools(frontmatter["tools"], config.defaultTools, filePath);
	const outputMode = frontmatter["output_mode"] === undefined ? undefined : parseOutputMode(frontmatter["output_mode"], "output_mode");
	const model = optionalString(frontmatter["model"], "model");
	const timeoutMs = optionalInteger(frontmatter["timeout_ms"], "timeout_ms");
	const retries = optionalInteger(frontmatter["retries"], "retries");
	return {
		name,
		description,
		...(model !== undefined ? { model } : {}),
		tools,
		...(outputMode !== undefined ? { outputMode } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(retries !== undefined ? { retries } : {}),
		systemPrompt: body.trim(),
		source,
		filePath,
		hasWriteCapability: hasWriteCapability(tools),
	};
}

function parseTools(value: unknown, defaults: string[], filePath: string): string[] {
	if (value === undefined || value === null) return [...defaults];
	if (typeof value !== "string") throw new Error("tools must be a comma-separated string.");
	const tools = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (tools.length === 0) throw new Error("tools must not be empty.");
	if (tools.includes("subagent")) throw new Error("tools must not include subagent.");
	if (tools.some((tool) => tool.includes(" "))) throw new Error(`tools contains an invalid name in ${filePath}.`);
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

function collectAncestorAgentsDirs(startDir: string): string[] {
	const dirs: string[] = [];
	const gitRoot = findGitRepoRoot(startDir);
	let current = path.resolve(startDir);
	while (true) {
		dirs.push(path.join(current, ".agents", "agents"));
		if (gitRoot !== undefined && current === gitRoot) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function findGitRepoRoot(startDir: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function isDirectory(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function safeRealpath(filePath: string): string | undefined {
	try {
		return realpathSync(filePath);
	} catch {
		return undefined;
	}
}

function isPathInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of paths) {
		const resolved = path.resolve(item);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		result.push(item);
	}
	return result;
}

function parseOutputMode(value: unknown, field: string): OutputMode {
	if (value === "inline" || value === "file") return value;
	throw new Error(`${field} must be inline or file.`);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") return value;
	throw new Error(`${field} must be a string.`);
}

function requireString(value: unknown, field: string): string {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	throw new Error(`${field} is required.`);
}

function optionalInteger(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "number" && Number.isInteger(value)) return value;
	throw new Error(`${field} must be an integer.`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
