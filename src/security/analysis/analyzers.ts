import type { AnalysisContext, AnalysisResult, AuthorizationAtom, ComponentAnalyzer } from "../model/types.js";
import { bashResourceUri, toolResourceUri } from "../model/resources.js";
import { FileResolver } from "../runtime/file-resolver.js";

interface LsInput {
	path: string;
}

interface ReadInput {
	path: string;
}

type EditInput = {
	operations: readonly EditOperation[];
};

type EditOperation =
	| { type: "create_file"; path: string }
	| { type: "update_file"; path: string }
	| { type: "replace_file"; path: string }
	| { type: "delete_file"; path: string }
	| { type: "move_file"; from: string; to: string };

export function fileToolAnalyzer(name: "ls" | "read" | "edit"): ComponentAnalyzer {
	if (name === "ls") return { analyze: analyzeLs };
	if (name === "read") return { analyze: analyzeRead };
	return { analyze: analyzeEdit };
}

export function opaqueToolAnalyzer(): ComponentAnalyzer {
	return {
		async analyze(_input: unknown, context: AnalysisContext): Promise<AnalysisResult> {
			return {
				exactness: "opaque",
				atoms: [{ action: "tool.invoke.opaque", resource: toolResourceUri(context.component) }],
			};
		},
	};
}

export function bashAnalyzer(): ComponentAnalyzer {
	return {
		async analyze(): Promise<AnalysisResult> {
			return {
				exactness: "opaque",
				atoms: [{ action: "exec.shell.opaque", resource: bashResourceUri() }],
			};
		},
	};
}

export function mcpToolAnalyzer(server: string, tool: string, resource: string): ComponentAnalyzer {
	return {
		async analyze(): Promise<AnalysisResult> {
			return {
				exactness: "opaque",
				atoms: [
					{ action: "mcp.server.connect", resource: `mcp://${encodeURIComponent(server)}` },
					{ action: "mcp.tool.invoke.opaque", resource },
					{ action: "mcp.tool.invoke", resource },
				],
			};
		},
	};
}

export function skillAnalyzer(resource: string): ComponentAnalyzer {
	return {
		async analyze(): Promise<AnalysisResult> {
			return {
				exactness: "conservative",
				atoms: [
					{ action: "skill.activate", resource },
					{ action: "skill.instructions.read", resource },
				],
			};
		},
	};
}

export function agentSpawnAnalyzer(resource: string): ComponentAnalyzer {
	return {
		async analyze(): Promise<AnalysisResult> {
			return {
				exactness: "conservative",
				atoms: [
					{ action: "agent.spawn", resource },
					{ action: "agent.delegate", resource },
				],
			};
		},
	};
}

async function analyzeLs(input: unknown, context: AnalysisContext): Promise<AnalysisResult> {
	const params = requireRecord(input);
	const path = requireString(params, "path");
	const resolver = new FileResolver(context);
	return { exactness: "exact", atoms: [await resolver.atom(path, "fs.list")] };
}

async function analyzeRead(input: unknown, context: AnalysisContext): Promise<AnalysisResult> {
	const params = requireRecord(input);
	const path = requireString(params, "path");
	const resolver = new FileResolver(context);
	return { exactness: "exact", atoms: [await resolver.atom(path, "fs.read")] };
}

async function analyzeEdit(input: unknown, context: AnalysisContext): Promise<AnalysisResult> {
	const params = requireRecord(input) as Partial<EditInput>;
	if (!Array.isArray(params.operations) || params.operations.length === 0) throw new Error("edit.operations must be a non-empty array.");
	const resolver = new FileResolver(context);
	const atoms: AuthorizationAtom[] = [];
	for (const operation of params.operations) {
		if (!isRecord(operation) || typeof operation.type !== "string") throw new Error("edit operation must include type.");
		if (operation.type === "create_file") {
			const target = requireString(operation, "path");
			atoms.push(await resolver.atom(target, "fs.create"), await resolver.atom(target, "fs.write"));
			continue;
		}
		if (operation.type === "update_file") {
			const target = requireString(operation, "path");
			atoms.push(await resolver.atom(target, "fs.read"), await resolver.atom(target, "fs.write"));
			continue;
		}
		if (operation.type === "replace_file") {
			const target = requireString(operation, "path");
			atoms.push(await resolver.atom(target, "fs.read"), await resolver.atom(target, "fs.replace"));
			continue;
		}
		if (operation.type === "delete_file") {
			atoms.push(await resolver.atom(requireString(operation, "path"), "fs.delete"));
			continue;
		}
		if (operation.type === "move_file") {
			const from = requireString(operation, "from");
			const to = requireString(operation, "to");
			atoms.push(
				await resolver.atom(from, "fs.read"),
				await resolver.atom(from, "fs.delete"),
				await resolver.atom(to, "fs.create"),
				await resolver.atom(to, "fs.write"),
				await resolver.atom(from, "fs.rename"),
				await resolver.atom(to, "fs.rename"),
			);
			continue;
		}
		throw new Error(`Unknown edit operation: ${operation.type}`);
	}
	return { exactness: "exact", atoms };
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("input must be an object.");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
	const entry = value[key];
	if (typeof entry !== "string") throw new Error(`${key} must be a string.`);
	return entry;
}
