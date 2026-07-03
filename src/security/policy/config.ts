import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser";

import { digest } from "../model/digest.js";
import type { ComponentKind } from "../model/types.js";
import type { PermissionCatalog } from "../catalog/permission-catalog.js";
import { compileUserPermissionPolicy } from "../config/user-policy-compiler.js";
import { defaultUserPermissionConfig, type UserPermissionConfig } from "../config/user-config.js";
import { generateCatalogSchema, userPermissionConfigSchema, validateUserPermissionSemantics, validateUserPermissionShape } from "../config/user-schema.js";
import type { CompiledSecurityPolicy } from "./policy.js";

/** 内部 IR 的组件上限；用户配置不得直接填写 action/resource。 */
export interface ComponentCeiling {
	tools?: readonly string[];
	bash?: boolean;
	mcp?: readonly string[];
	skills?: readonly string[];
	agents?: readonly string[];
	actions?: readonly string[];
	resources?: readonly string[];
}

export interface LoadedSecurityPolicy {
	path: string;
	status: "missing" | "loaded" | "invalid" | "load_failed" | "untrusted";
	diagnostics: readonly string[];
	config?: UserPermissionConfig;
}

export interface PolicySnapshot {
	digest: string;
	valid: boolean;
	global: LoadedSecurityPolicy;
	project: LoadedSecurityPolicy;
	compiled: CompiledSecurityPolicy;
	auditEnabled: boolean;
}

export const securityConfigSchema = userPermissionConfigSchema;

export class PolicyStore {
	constructor(
		private readonly options: {
			workspaceRoot: string;
			agentDir: string;
			projectTrusted: boolean;
			globalPolicyPath?: string;
			projectPolicyPath?: string;
			catalog: () => PermissionCatalog;
		},
	) {}

	async snapshot(): Promise<PolicySnapshot> {
		const catalog = this.options.catalog();
		const globalLoaded = await loadSecurityConfig(this.globalPath());
		const project = this.options.projectTrusted
			? await loadSecurityConfig(this.projectPath())
			: { path: this.projectPath(), status: "untrusted" as const, diagnostics: [] };
		const globalDiagnostics = globalLoaded.config === undefined ? [] : validateUserPermissionSemantics(globalLoaded.config, catalog);
		const global = globalDiagnostics.length === 0 ? globalLoaded : { ...globalLoaded, status: "invalid" as const, diagnostics: globalDiagnostics };
		const projectSemanticDiagnostics = project.config === undefined ? [] : validateUserPermissionSemantics(project.config, catalog);
		const projectFinal = projectSemanticDiagnostics.length === 0 ? project : { ...project, status: "invalid" as const, diagnostics: projectSemanticDiagnostics };
		let valid = !["invalid", "load_failed"].includes(global.status) && !["invalid", "load_failed"].includes(projectFinal.status);
		const compileResult = compileUserPermissionPolicy({
			global: global.config ?? defaultUserPermissionConfig(),
			...(projectFinal.config !== undefined ? { project: projectFinal.config } : {}),
			catalog,
			workspaceRoot: this.options.workspaceRoot,
			agentDir: this.options.agentDir,
		});
		if (compileResult.diagnostics.length > 0) valid = false;
		const compiled = valid
			? compileResult.policy
			: compileUserPermissionPolicy({
					global: lockedDownConfig(),
					catalog,
					workspaceRoot: this.options.workspaceRoot,
					agentDir: this.options.agentDir,
				}).policy;
		return {
			digest: digest({ global, project: projectFinal, compiled }),
			valid,
			global: compileResult.diagnostics.length === 0 ? global : { ...global, status: "invalid", diagnostics: [...global.diagnostics, ...compileResult.diagnostics] },
			project: projectFinal,
			compiled,
			auditEnabled: global.config?.audit?.enabled ?? true,
		};
	}

	async writeSchema(targetPath = path.join(this.options.agentDir, "permissions.schema.json")): Promise<void> {
		await mkdir(path.dirname(targetPath), { recursive: true });
		await writeFile(targetPath, `${JSON.stringify(generateCatalogSchema(this.options.catalog()), null, "\t")}\n`, "utf8");
	}

	async setUserMode(input: {
		level: "global" | "agent";
		agent?: string;
		category: "tool" | "mcp" | "skill" | "subagent";
		name: string;
		mode: "off" | "allow" | "ask" | "always-ask";
	}): Promise<void> {
		const filePath = this.globalPath();
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				text = `${JSON.stringify(defaultUserPermissionConfig(), null, "\t")}\n`;
			} else {
				throw error;
			}
		}
		const targetPath = userModeJsonPath(input);
		const edits = modify(text, targetPath, input.mode, { formattingOptions: { insertSpaces: false, tabSize: 1 } });
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, applyEdits(text, edits), "utf8");
	}

	globalPath(): string {
		return this.options.globalPolicyPath ?? path.join(this.options.agentDir, "permissions.jsonc");
	}

	projectPath(): string {
		return this.options.projectPolicyPath ?? path.join(this.options.workspaceRoot, ".pi", "permissions.jsonc");
	}
}

function userModeJsonPath(input: {
	level: "global" | "agent";
	agent?: string;
	category: "tool" | "mcp" | "skill" | "subagent";
	name: string;
}): (string | number)[] {
	const root = input.level === "global" ? ["global"] : ["agents", input.agent ?? "main"];
	if (input.category === "tool") return [...root, "tools", input.name];
	if (input.category === "skill") return [...root, "skills", input.name];
	if (input.category === "subagent") return [...root, "subagents", input.name];
	const [server, tool, extra] = input.name.split("/");
	if (server === undefined || tool === undefined || extra !== undefined || server === "" || tool === "") {
		throw new Error("MCP name must use server/tool.");
	}
	return [...root, "mcp", server, tool];
}

export function lockedDownConfig(): UserPermissionConfig {
	return {
		version: 1,
		global: { tools: { "*": "off" }, mcp: { "*": "off" }, skills: { "*": "off" }, subagents: { "*": "off" } },
		agents: { main: { tools: { "*": "off" }, mcp: { "*": "off" }, skills: { "*": "off" }, subagents: { "*": "off" } } },
	};
}

export async function loadSecurityConfig(filePath: string): Promise<LoadedSecurityPolicy> {
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return { path: filePath, status: "invalid", diagnostics: ["Policy path is not a file."] };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { path: filePath, status: "missing", diagnostics: [] };
		}
		return { path: filePath, status: "load_failed", diagnostics: [String(error)] };
	}
	try {
		const text = await readFile(filePath, "utf8");
		const errors: ParseError[] = [];
		const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
		if (errors.length > 0) return { path: filePath, status: "invalid", diagnostics: errors.map((error) => printParseErrorCode(error.error)) };
		const diagnostics = validateUserPermissionShape(parsed);
		if (diagnostics.length > 0) return { path: filePath, status: "invalid", diagnostics };
		return { path: filePath, status: "loaded", diagnostics: [], config: parsed as UserPermissionConfig };
	} catch (error) {
		return { path: filePath, status: "invalid", diagnostics: [error instanceof Error ? error.message : String(error)] };
	}
}

export function componentNames(ceiling: ComponentCeiling | undefined, kind: ComponentKind): readonly string[] | boolean | undefined {
	if (ceiling === undefined) return undefined;
	if (kind === "tool") return ceiling.tools;
	if (kind === "bash") return ceiling.bash;
	if (kind === "mcp-server" || kind === "mcp-tool") return ceiling.mcp;
	if (kind === "skill") return ceiling.skills;
	return ceiling.agents;
}
