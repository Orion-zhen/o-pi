import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { parse, parseTree, getLocation, type ParseError, printParseErrorCode } from "jsonc-parser";
import picomatch from "picomatch";

import type {
	CompiledDecision,
	DecisionTraceEntry,
	FileAccess,
	FileRootGrant,
	LoadedPolicy,
	PermissionConfig,
	PermissionEffect,
	PermissionProfile,
	PermissionResource,
	PermissionSubject,
	PolicyDiagnostic,
	PolicySnapshot,
	PermissionOperation,
} from "./permission-types.js";
import { effectRank, isWriteOperation } from "./permission-types.js";
import { expandConfiguredPath, isPathInside } from "./path-utils.js";

export const permissionsSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://pi.local/permissions.schema.json",
	type: "object",
	additionalProperties: false,
	required: ["version"],
	properties: {
		$schema: { type: "string" },
		version: { const: 1 },
		profile: { enum: ["cautious", "standard", "read-only", "unrestricted"] },
		files: {
			type: "object",
			additionalProperties: false,
			properties: {
				roots: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["path", "access"],
						properties: {
							path: { type: "string", minLength: 1 },
							access: { enum: ["read-only", "read-write"] },
						},
					},
				},
				outsideRoots: {
					type: "object",
					additionalProperties: false,
					properties: {
						read: { enum: ["allow", "ask", "deny"] },
						write: { enum: ["allow", "ask", "deny"] },
					},
				},
				rules: { $ref: "#/$defs/fileEffectRules" },
			},
		},
		tools: { $ref: "#/$defs/toolRuleSet" },
		mcp: {
			type: "object",
			additionalProperties: false,
			properties: {
				default: { $ref: "#/$defs/effect" },
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						additionalProperties: false,
						properties: {
							default: { $ref: "#/$defs/effect" },
							tools: {
								type: "object",
								additionalProperties: { $ref: "#/$defs/effect" },
							},
						},
					},
				},
			},
		},
		skills: { $ref: "#/$defs/simpleRuleSet" },
		agents: { $ref: "#/$defs/simpleRuleSet" },
		audit: {
			type: "object",
			additionalProperties: false,
			required: ["enabled"],
			properties: { enabled: { type: "boolean" } },
		},
	},
	$defs: {
		effect: { enum: ["allow", "ask", "deny"] },
		fileRule: {
			type: "object",
			additionalProperties: false,
			required: ["paths", "access"],
			properties: {
				id: { type: "string", minLength: 1 },
				paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
				access: { type: "array", minItems: 1, items: { enum: ["read", "write"] } },
			},
		},
		fileEffectRules: {
			type: "object",
			additionalProperties: false,
			properties: {
				deny: { type: "array", items: { $ref: "#/$defs/fileRule" } },
				ask: { type: "array", items: { $ref: "#/$defs/fileRule" } },
				allow: { type: "array", items: { $ref: "#/$defs/fileRule" } },
			},
		},
		commandEffectRules: {
			type: "object",
			additionalProperties: false,
			properties: {
				deny: { type: "array", items: { type: "string", minLength: 1 } },
				ask: { type: "array", items: { type: "string", minLength: 1 } },
				allow: { type: "array", items: { type: "string", minLength: 1 } },
			},
		},
		toolConfig: {
			oneOf: [
				{ $ref: "#/$defs/effect" },
				{
					type: "object",
					additionalProperties: false,
					properties: {
						default: { $ref: "#/$defs/effect" },
						commands: { $ref: "#/$defs/commandEffectRules" },
					},
				},
			],
		},
		toolRuleSet: {
			type: "object",
			additionalProperties: false,
			properties: {
				default: { $ref: "#/$defs/effect" },
				items: {
					type: "object",
					additionalProperties: { $ref: "#/$defs/toolConfig" },
				},
			},
		},
		simpleRuleSet: {
			type: "object",
			additionalProperties: false,
			properties: {
				default: { $ref: "#/$defs/effect" },
				items: {
					type: "object",
					additionalProperties: { $ref: "#/$defs/effect" },
				},
			},
		},
	},
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(permissionsSchema);

export interface PolicyStoreOptions {
	workspaceRoot: string;
	agentDir: string;
	projectTrusted: boolean;
	globalPolicyPath?: string;
	projectPolicyPath?: string;
}

export class PolicyStore {
	private generation = 0;
	private lastSignature = "";
	private snapshotValue: PolicySnapshot | undefined;
	private pendingSnapshot: Promise<PolicySnapshot> | undefined;

	constructor(private readonly options: PolicyStoreOptions) {}

	async snapshot(): Promise<PolicySnapshot> {
		if (this.pendingSnapshot !== undefined) return await this.pendingSnapshot;
		this.pendingSnapshot = this.computeSnapshot().finally(() => {
			this.pendingSnapshot = undefined;
		});
		return await this.pendingSnapshot;
	}

	private async computeSnapshot(): Promise<PolicySnapshot> {
		const global = await loadPolicy("global", this.globalPath());
		const project = this.options.projectTrusted
			? await loadPolicy("project", this.projectPath())
			: { source: "project" as const, path: this.projectPath(), status: "untrusted" as const, diagnostics: [] };
		const projectDiagnostics = project.config === undefined ? [] : validateProjectConfig(project.path, project.config);
		const projectFinal: LoadedPolicy = projectDiagnostics.length > 0 ? { ...project, status: "invalid", diagnostics: projectDiagnostics } : project;
		const diagnostics = [...global.diagnostics, ...projectFinal.diagnostics];
		const valid = diagnostics.length === 0 && global.status !== "invalid" && global.status !== "load_failed" && projectFinal.status !== "invalid" && projectFinal.status !== "load_failed";
		const profile = global.config?.profile ?? "standard";
		let roots: FileRootGrant[] = [];
		if (valid) {
			try {
				roots = await compileRoots(this.options.workspaceRoot, this.options.agentDir, global.config);
			} catch (error) {
				diagnostics.push(diagnostic(this.globalPath(), "", 1, 1, error instanceof Error ? error.message : String(error)));
			}
		}
		const signature = JSON.stringify({ global, projectFinal, roots, valid });
		if (signature !== this.lastSignature) {
			this.generation += 1;
			this.lastSignature = signature;
		}
		const snapshot: PolicySnapshot = {
			generation: this.generation,
			valid: diagnostics.length === 0 && valid,
			global,
			project: projectFinal,
			profile,
			roots,
			diagnostics,
			auditEnabled: global.config?.audit?.enabled ?? true,
		};
		if (global.config !== undefined) snapshot.globalConfig = global.config;
		if (projectFinal.config !== undefined) snapshot.projectConfig = projectFinal.config;
		this.snapshotValue = snapshot;
		return snapshot;
	}

	async writeSchema(targetPath = path.join(this.options.agentDir, "permissions.schema.json")): Promise<void> {
		await mkdir(path.dirname(targetPath), { recursive: true });
		await writeFile(targetPath, `${JSON.stringify(permissionsSchema, null, "\t")}\n`, "utf8");
	}

	globalPath(): string {
		return this.options.globalPolicyPath ?? path.join(this.options.agentDir, "permissions.jsonc");
	}

	projectPath(): string {
		return this.options.projectPolicyPath ?? path.join(this.options.workspaceRoot, ".pi", "permissions.jsonc");
	}
}

export function defaultAgentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
}

export function defaultPermissionConfig(): PermissionConfig {
	return {
		$schema: "./permissions.schema.json",
		version: 1,
		profile: "standard",
		files: {
			roots: [{ path: "${workspace}", access: "read-write" }],
			outsideRoots: { read: "ask", write: "ask" },
			rules: {
				deny: [
					{ paths: ["~/.ssh/**", "~/.gnupg/**"], access: ["read", "write"] },
				],
				ask: [{ paths: ["**/.env", "**/.env.*"], access: ["read"] }],
				allow: [],
			},
		},
		tools: { default: "ask", items: { ls: "allow", read: "allow", edit: "allow" } },
		mcp: { default: "ask", servers: {} },
		skills: { default: "ask", items: {} },
		agents: { default: "ask", items: {} },
		audit: { enabled: true },
	};
}

export async function loadPolicy(source: "global" | "project", filePath: string): Promise<LoadedPolicy> {
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return { source, path: filePath, status: "invalid", diagnostics: [diagnostic(filePath, "", 1, 1, "Policy path is not a file.")] };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { source, path: filePath, status: "missing", diagnostics: [] };
		}
		return { source, path: filePath, status: "load_failed", diagnostics: [diagnostic(filePath, "", 1, 1, errorMessage(error))] };
	}
	try {
		const text = await readFile(filePath, "utf8");
		const parsed = parseJsoncWithDiagnostics(filePath, text);
		if (!parsed.ok) return { source, path: filePath, status: "invalid", diagnostics: parsed.diagnostics };
		if (!validate(parsed.value)) {
			return { source, path: filePath, status: "invalid", diagnostics: ajvDiagnostics(filePath, text, validate.errors ?? []) };
		}
		const duplicates = duplicateRuleDiagnostics(filePath, text, parsed.value);
		if (duplicates.length > 0) return { source, path: filePath, status: "invalid", diagnostics: duplicates };
		return { source, path: filePath, status: "loaded", diagnostics: [], config: parsed.value };
	} catch (error) {
		return { source, path: filePath, status: "invalid", diagnostics: [diagnostic(filePath, "", 1, 1, errorMessage(error))] };
	}
}

export function evaluatePolicy(request: {
	snapshot: PolicySnapshot;
	subject: PermissionSubject;
	resources: PermissionResource[];
	operations: string[];
}): CompiledDecision {
	const trace: DecisionTraceEntry[] = [];
	if (!request.snapshot.valid) {
		trace.push({ source: "policy-error", effect: "policy-error", message: formatDiagnostics(request.snapshot.diagnostics) });
		return { effect: "policy-error", finalEffect: "deny", source: "policy-error", trace };
	}

	if (request.snapshot.profile === "read-only" && request.operations.some((operation) => isWriteOperation(operation as PermissionOperation))) {
		trace.push({ source: "profile", effect: "deny", message: "read-only denies mutating operations" });
		return decisionFromTrace(trace);
	}

	addProjectDecisions(trace, request);
	addGlobalDecisions(trace, request);

	if (trace.length === 0) {
		trace.push({ source: "profile", effect: profileBaseline(request.snapshot.profile, request.subject, request.resources, request.operations), message: `profile ${request.snapshot.profile}` });
	}

	return decisionFromTrace(trace);
}

function addProjectDecisions(
	trace: DecisionTraceEntry[],
	request: {
		snapshot: PolicySnapshot;
		subject: PermissionSubject;
		resources: PermissionResource[];
	},
): void {
	const projectExplicit = explicitSubjectDecision(request.snapshot.projectConfig, request.subject);
	if (projectExplicit !== undefined) trace.push({ source: "project-policy", effect: projectExplicit.effect, message: projectExplicit.message });
	const projectFiles = fileDecision(request.snapshot.projectConfig, request.snapshot.roots, request.resources, true);
	if (projectFiles !== undefined) trace.push(traceEntry("project-policy", projectFiles.effect, projectFiles.message, projectFiles.ruleId));
	const projectCommand = commandDecision(request.snapshot.projectConfig, request.subject, request.resources);
	if (projectCommand !== undefined) trace.push(traceEntry("project-policy", projectCommand.effect, projectCommand.message));
}

function addGlobalDecisions(
	trace: DecisionTraceEntry[],
	request: {
		snapshot: PolicySnapshot;
		subject: PermissionSubject;
		resources: PermissionResource[];
	},
): void {
	const globalExplicit = explicitSubjectDecision(request.snapshot.globalConfig, request.subject);
	if (globalExplicit !== undefined) trace.push({ source: "global-policy", effect: globalExplicit.effect, message: globalExplicit.message });
	const globalCommand = commandDecision(request.snapshot.globalConfig, request.subject, request.resources);
	if (globalCommand !== undefined) trace.push(traceEntry("global-policy", globalCommand.effect, globalCommand.message));
	const globalFiles = fileDecision(request.snapshot.globalConfig, request.snapshot.roots, request.resources, false);
	if (globalFiles !== undefined) trace.push(traceEntry("global-policy", globalFiles.effect, globalFiles.message, globalFiles.ruleId));
}

function decisionFromTrace(trace: DecisionTraceEntry[]): CompiledDecision {
	const winning = strongestEntry(trace);
	return {
		effect: winning.effect,
		finalEffect: winning.effect,
		source: winning.source,
		trace,
		...(winning.ruleId !== undefined ? { ruleId: winning.ruleId } : {}),
	};
}

type PolicyTraceEntry = DecisionTraceEntry & { effect: PermissionEffect };

function strongestEntry(trace: DecisionTraceEntry[]): DecisionTraceEntry & { effect: PermissionEffect } {
	let result: PolicyTraceEntry | undefined;
	for (const entry of trace) {
		if (!isPolicyTraceEntry(entry)) continue;
		if (result === undefined || effectRank(entry.effect) > effectRank(result.effect)) result = entry;
	}
	if (result === undefined) throw new Error("Permission decision trace must contain a policy effect.");
	return result;
}

function isPolicyTraceEntry(entry: DecisionTraceEntry): entry is PolicyTraceEntry {
	return entry.effect === "allow" || entry.effect === "ask" || entry.effect === "deny";
}

function commandDecision(
	config: PermissionConfig | undefined,
	subject: PermissionSubject,
	resources: PermissionResource[],
): { effect: PermissionEffect; message: string } | undefined {
	if (config === undefined || subject.kind !== "tool") return undefined;
	const commands = resources.filter((resource) => resource.kind === "command");
	if (commands.length === 0) return undefined;
	const item = config.tools?.items?.[subject.configKey];
	if (typeof item !== "object" || item === null) return undefined;
	for (const effect of ["deny", "ask", "allow"] as const) {
		for (const pattern of item.commands?.[effect] ?? []) {
			const matcher = picomatch(pattern, { dot: true, nocase: process.platform === "win32" });
			if (commands.some((command) => matcher(command.command))) return { effect, message: `tools.items.${subject.configKey}.commands.${effect}` };
		}
	}
	return undefined;
}

export function formatDiagnostics(diagnostics: PolicyDiagnostic[]): string {
	if (diagnostics.length === 0) return "Policy is invalid.";
	return diagnostics.map((item) => `${item.file}${item.pointer}:${item.line}:${item.column} ${item.message}`).join("; ");
}

async function compileRoots(workspaceRoot: string, agentDir: string, config: PermissionConfig | undefined): Promise<FileRootGrant[]> {
	const roots = config?.files?.roots ?? [{ path: "${workspace}", access: "read-write" as const }];
	const compiled: FileRootGrant[] = [];
	for (const root of roots) {
		try {
			const canonicalPath = await realpath(expandConfiguredPath(root.path, { workspace: workspaceRoot, agentDir }));
			const info = await stat(canonicalPath);
			if (!info.isDirectory()) throw new Error("Root path is not a directory.");
			compiled.push({
				canonicalPath,
				access: root.access,
				source: "global-config",
			});
		} catch (error) {
			throw new Error(`Cannot canonicalize root "${root.path}": ${errorMessage(error)}`);
		}
	}
	return compiled;
}

function profileBaseline(
	profile: PermissionProfile,
	subject: PermissionSubject,
	resources: PermissionResource[],
	operations: string[],
): PermissionEffect {
	if (profile === "read-only") return operations.some((operation) => isWriteOperation(operation as PermissionOperation)) ? "deny" : "ask";
	if (profile === "cautious") return resources.some((resource) => resource.kind === "file" && resource.access === "read") ? "allow" : "ask";
	if (profile === "unrestricted") return "allow";
	if (subject.kind !== "tool") return "ask";
	if (subject.configKey === "ls" || subject.configKey === "read" || subject.configKey === "edit") return "allow";
	return "ask";
}

function explicitSubjectDecision(
	config: PermissionConfig | undefined,
	subject: PermissionSubject,
): { effect: PermissionEffect; message: string } | undefined {
	if (config === undefined) return undefined;
	if (subject.kind === "tool") {
		const item = config.tools?.items?.[subject.configKey];
		if (typeof item === "string") return { effect: item, message: `tools.items.${subject.configKey}` };
		if (item?.default !== undefined) return { effect: item.default, message: `tools.items.${subject.configKey}.default` };
		if (config.tools?.default !== undefined) return { effect: config.tools.default, message: "tools.default" };
	}
	if (subject.kind === "mcp-tool") {
		const [server, tool] = subject.configKey.split("/", 2);
		const serverConfig = server === undefined ? undefined : config.mcp?.servers?.[server];
		const toolEffect = tool === undefined ? undefined : serverConfig?.tools?.[tool];
		if (toolEffect !== undefined) return { effect: toolEffect, message: `mcp.servers.${server}.tools.${tool}` };
		if (serverConfig?.default !== undefined) return { effect: serverConfig.default, message: `mcp.servers.${server}.default` };
		if (config.mcp?.default !== undefined) return { effect: config.mcp.default, message: "mcp.default" };
	}
	if (subject.kind === "skill") {
		const item = config.skills?.items?.[subject.configKey];
		if (item !== undefined) return { effect: item, message: `skills.items.${subject.configKey}` };
		if (config.skills?.default !== undefined) return { effect: config.skills.default, message: "skills.default" };
	}
	if (subject.kind === "agent") {
		const item = config.agents?.items?.[subject.configKey];
		if (item !== undefined) return { effect: item, message: `agents.items.${subject.configKey}` };
		if (config.agents?.default !== undefined) return { effect: config.agents.default, message: "agents.default" };
	}
	return undefined;
}

function fileDecision(
	config: PermissionConfig | undefined,
	roots: FileRootGrant[],
	resources: PermissionResource[],
	project: boolean,
): { effect: PermissionEffect; message: string; ruleId?: string } | undefined {
	const files = resources.filter((resource) => resource.kind === "file");
	if (files.length === 0) return undefined;
	for (const effect of ["deny", "ask", "allow"] as const) {
		if (project && effect === "allow") continue;
		const rules = config?.files?.rules?.[effect] ?? [];
		for (let index = 0; index < rules.length; index += 1) {
			const rule = rules[index];
			if (rule === undefined) continue;
			for (const file of files) {
				if (!rule.access.includes(file.access)) continue;
				if (rule.paths.some((pattern) => fileRuleMatches(pattern, file.canonicalPath, file.lexicalAbsolutePath))) {
					return withOptionalRuleId(effect, `files.rules.${effect}[${index}]`, rule.id);
				}
			}
		}
	}
	if (project) return undefined;
	let aggregate: PermissionEffect | undefined;
	let aggregateMessage: string | undefined;
	for (const file of files) {
		const root = selectFileRoot(roots, file.canonicalPath);
		const effect = root === undefined
			? config?.files?.outsideRoots?.[file.access] ?? "ask"
			: root.access === "read-write" || file.access === "read"
				? "allow"
				: "ask";
		if (aggregate === undefined || effectRank(effect) > effectRank(aggregate)) {
			aggregate = effect;
			aggregateMessage = fileBoundaryMessage(file, root, effect);
		}
	}
	return aggregate === undefined ? undefined : { effect: aggregate, message: aggregateMessage ?? "files root/outsideRoots" };
}

function fileBoundaryMessage(file: Extract<PermissionResource, { kind: "file" }>, root: FileRootGrant | undefined, effect: PermissionEffect): string {
	if (root === undefined) return `files.outsideRoots.${file.access} ${effect} for ${file.canonicalPath}`;
	if (root.access === "read-write" || file.access === "read") return `files.root ${root.access} allows ${file.access} for ${file.canonicalPath}; root ${root.canonicalPath}`;
	return `files.root ${root.access} asks ${file.access} for ${file.canonicalPath}; root ${root.canonicalPath}`;
}

function selectFileRoot(roots: FileRootGrant[], canonicalPath: string): FileRootGrant | undefined {
	let selected: FileRootGrant | undefined;
	for (const root of roots) {
		if (!isPathInside(root.canonicalPath, canonicalPath)) continue;
		if (selected === undefined || rootPrecedence(root) > rootPrecedence(selected)) selected = root;
	}
	return selected;
}

function rootPrecedence(root: FileRootGrant): number {
	return path.resolve(root.canonicalPath).length * 2 + (root.access === "read-only" ? 1 : 0);
}

function fileRuleMatches(pattern: string, canonicalPath: string, lexicalPath: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/");
	const matcher = picomatch(normalizedPattern, { dot: true, nocase: process.platform === "win32" });
	return matcher(canonicalPath.replace(/\\/g, "/")) || matcher(lexicalPath.replace(/\\/g, "/"));
}

function traceEntry(source: DecisionTraceEntry["source"], effect: DecisionTraceEntry["effect"], message: string, ruleId?: string): DecisionTraceEntry {
	return ruleId === undefined ? { source, effect, message } : { source, effect, message, ruleId };
}

function withOptionalRuleId(effect: PermissionEffect, message: string, ruleId: string | undefined): { effect: PermissionEffect; message: string; ruleId?: string } {
	return ruleId === undefined ? { effect, message } : { effect, message, ruleId };
}

function parseJsoncWithDiagnostics(file: string, text: string): { ok: true; value: PermissionConfig } | { ok: false; diagnostics: PolicyDiagnostic[] } {
	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
	if (errors.length > 0) {
		return {
			ok: false,
			diagnostics: errors.map((error) => {
				const location = getLocation(text, error.offset);
				const position = offsetPosition(text, error.offset);
				return diagnostic(file, pointerFromSegments(location.path), position.line, position.column, printParseErrorCode(error.error));
			}),
		};
	}
	return { ok: true, value: value as PermissionConfig };
}

function ajvDiagnostics(file: string, text: string, errors: ErrorObject[]): PolicyDiagnostic[] {
	return errors.map((error) => {
		const pointer = error.instancePath || "";
		const position = offsetPosition(text, pointerOffset(text, pointer));
		return diagnostic(file, pointer, position.line, position.column, ajvMessage(error));
	});
}

export function validateProjectConfig(file: string, config: PermissionConfig): PolicyDiagnostic[] {
	const diagnostics: PolicyDiagnostic[] = [];
	if (config.profile !== undefined) diagnostics.push(diagnostic(file, "/profile", 1, 1, "Project policy cannot set profile."));
	if (config.files?.roots !== undefined) diagnostics.push(diagnostic(file, "/files/roots", 1, 1, "Project policy cannot add roots."));
	if (config.files?.outsideRoots !== undefined) diagnostics.push(diagnostic(file, "/files/outsideRoots", 1, 1, "Project policy cannot set outsideRoots."));
	if (config.audit !== undefined) diagnostics.push(diagnostic(file, "/audit", 1, 1, "Project policy cannot configure audit."));
	if ((config.files?.rules?.allow?.length ?? 0) > 0) diagnostics.push(diagnostic(file, "/files/rules/allow", 1, 1, "Project policy cannot allow."));
	if (hasAllow(config.tools)) diagnostics.push(diagnostic(file, "/tools", 1, 1, "Project policy cannot allow tools."));
	if (hasAllow(config.mcp)) diagnostics.push(diagnostic(file, "/mcp", 1, 1, "Project policy cannot allow MCP tools."));
	if (hasAllow(config.skills)) diagnostics.push(diagnostic(file, "/skills", 1, 1, "Project policy cannot allow skills."));
	if (hasAllow(config.agents)) diagnostics.push(diagnostic(file, "/agents", 1, 1, "Project policy cannot allow agents."));
	return diagnostics;
}

function hasAllow(value: unknown): boolean {
	return JSON.stringify(value)?.includes("\"allow\"") ?? false;
}

function duplicateRuleDiagnostics(file: string, text: string, config: PermissionConfig): PolicyDiagnostic[] {
	const seen = new Set<string>();
	const diagnostics: PolicyDiagnostic[] = [];
	for (const effect of ["deny", "ask", "allow"] as const) {
		for (const rule of config.files?.rules?.[effect] ?? []) {
			if (rule.id === undefined) continue;
			if (seen.has(rule.id)) {
				const pointer = `/files/rules/${effect}`;
				const position = offsetPosition(text, pointerOffset(text, pointer));
				diagnostics.push(diagnostic(file, pointer, position.line, position.column, `Duplicate rule id "${rule.id}".`));
			}
			seen.add(rule.id);
		}
	}
	return diagnostics;
}

function offsetPosition(text: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	for (let index = 0; index < Math.min(offset, text.length); index += 1) {
		if (text[index] === "\n") {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

function ajvMessage(error: ErrorObject): string {
	if (error.keyword === "additionalProperties" && "additionalProperty" in error.params) {
		return `Unknown property "${String(error.params.additionalProperty)}".`;
	}
	return error.message ?? "Schema validation failed.";
}

function pointerOffset(text: string, pointer: string): number {
	const tree = parseTree(text);
	if (tree === undefined || pointer === "") return 0;
	const location = getLocation(text, 0);
	const segments = pointer.split("/").slice(1).map((item) => item.replace(/~1/g, "/").replace(/~0/g, "~"));
	for (let offset = 0; offset < text.length; offset += 1) {
		const current = getLocation(text, offset);
		if (JSON.stringify(current.path) === JSON.stringify(segments)) return offset;
	}
	return location.previousNode?.offset ?? 0;
}

function pointerFromSegments(segments: readonly (string | number)[]): string {
	return segments.length === 0 ? "" : segments.map((item) => `/${String(item).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function diagnostic(file: string, pointer: string, line: number, column: number, message: string): PolicyDiagnostic {
	return { file, pointer, line, column, message };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
