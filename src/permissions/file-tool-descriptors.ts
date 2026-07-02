import path from "node:path";

import type { EditOperation } from "../file-tools/types.js";
import { FileResolver } from "./file-resolver.js";
import type {
	CommandResource,
	PermissionAnalysisContext,
	PermissionIntent,
	PermissionOperation,
	PermissionSubjectDescriptor,
	ResolvedFileResource,
} from "./permission-types.js";

export interface LsInput {
	path: string;
}

export interface ReadInput {
	path: string;
}

/** 内置 ls/read/edit descriptor；文件工具和 tool_call 门禁使用同一分析逻辑。 */
export function builtinFileToolDescriptors(): PermissionSubjectDescriptor[] {
	return [lsDescriptor(), readDescriptor(), editDescriptor()];
}

export function lsDescriptor(): PermissionSubjectDescriptor<LsInput> {
	return {
		id: "tool:extension/o-pi/ls",
		kind: "tool",
		configKey: "ls",
		displayName: "ls",
		source: { type: "extension", name: "o-pi", identity: extensionIdentity() },
		async analyze(input, context) {
			const file = await resolver(context).resolve(requireString(input.path, "path"), "file.list", "read");
			return intent("List directory", [file]);
		},
	};
}

export function readDescriptor(): PermissionSubjectDescriptor<ReadInput> {
	return {
		id: "tool:extension/o-pi/read",
		kind: "tool",
		configKey: "read",
		displayName: "read",
		source: { type: "extension", name: "o-pi", identity: extensionIdentity() },
		async analyze(input, context) {
			const file = await resolver(context).resolve(requireString(input.path, "path"), "file.read", "read");
			return intent("Read file", [file]);
		},
	};
}

export function editDescriptor(): PermissionSubjectDescriptor<{ operations: EditOperation[] }> {
	return {
		id: "tool:extension/o-pi/edit",
		kind: "tool",
		configKey: "edit",
		displayName: "edit",
		source: { type: "extension", name: "o-pi", identity: extensionIdentity() },
		async analyze(input, context) {
			if (!Array.isArray(input.operations)) throw new Error("edit.operations must be an array.");
			const resources: ResolvedFileResource[] = [];
			for (const operation of input.operations) {
				if (operation.type === "create_file") {
					resources.push(await resolver(context).resolve(operation.path, "file.create", "write"));
				} else if (operation.type === "update_file") {
					resources.push(await resolver(context).resolve(operation.path, "file.update", "write"));
				} else if (operation.type === "replace_file") {
					resources.push(await resolver(context).resolve(operation.path, "file.replace", "write"));
				} else if (operation.type === "delete_file") {
					resources.push(await resolver(context).resolve(operation.path, "file.delete", "write"));
				} else if (operation.type === "move_file") {
					resources.push(await resolver(context).resolve(operation.from, "file.move", "write"));
					resources.push(await resolver(context).resolve(operation.to, "file.move", "write"));
				}
			}
			return intent("Edit files", resources);
		},
	};
}

export function genericToolDescriptor(toolName: string): PermissionSubjectDescriptor {
	if (toolName === "bash") return bashDescriptor();
	return {
		id: `tool:external/${toolName}`,
		kind: "tool",
		configKey: toolName,
		displayName: toolName,
		source: { type: "extension", name: "unknown", identity: `tool:${toolName}` },
		async analyze(): Promise<PermissionIntent> {
			return { operations: [], resources: [], summary: `Invoke tool ${toolName}` };
		},
	};
}

export function bashDescriptor(): PermissionSubjectDescriptor<{ command?: string } | string> {
	return {
		id: "tool:builtin/bash",
		kind: "tool",
		configKey: "bash",
		displayName: "Run shell command",
		source: { type: "builtin", name: "pi", identity: "builtin:bash" },
		async analyze(input): Promise<PermissionIntent> {
			const command = typeof input === "string" ? input : input.command;
			if (typeof command !== "string" || command.trim() === "") throw new Error("bash command must be a non-empty string.");
			const resource: CommandResource = { kind: "command", command };
			return { operations: ["process.execute"], resources: [resource], summary: `Run command: ${command.slice(0, 120)}` };
		},
	};
}

function intent(summary: string, files: ResolvedFileResource[]): PermissionIntent {
	const operations = Array.from(new Set(files.map((file) => file.operation))) as PermissionOperation[];
	return {
		operations,
		resources: files,
		summary,
		details: files.map((file) => `${file.operation} ${file.displayPath}`),
	};
}

function resolver(context: PermissionAnalysisContext): FileResolver {
	return new FileResolver({ workspaceRoot: context.workspaceRoot, agentDir: context.agentDir });
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
	return value;
}

function extensionIdentity(): string {
	return path.resolve("agent/extensions/file-tools.ts");
}
