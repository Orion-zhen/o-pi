import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LoadedPermissionPolicy, PermissionPolicyFile } from "./permission-types.js";
import { permissionsSchema, validatePolicyFile } from "./policy-schema.js";

export interface PolicyLoaderOptions {
	globalPolicyPath?: string;
	projectPolicyPath?: string;
	projectTrusted: boolean;
}

/** 加载 JSONC 权限策略并维护 generation；解析失败不会宽松放行。 */
export class PolicyLoader {
	private generation = 0;
	private lastGlobal: LoadedPermissionPolicy | undefined;
	private lastProject: LoadedPermissionPolicy | undefined;

	constructor(private readonly options: PolicyLoaderOptions) {}

	getGeneration(): number {
		return this.generation;
	}

	async load(): Promise<{ global: LoadedPermissionPolicy; project: LoadedPermissionPolicy; generation: number }> {
		const global = await loadPolicy("global", this.globalPolicyPath());
		const project = this.options.projectTrusted
			? await loadPolicy("project", this.options.projectPolicyPath ?? "")
			: { source: "project" as const, path: this.options.projectPolicyPath ?? "", status: "untrusted" as const };
		if (JSON.stringify(global) !== JSON.stringify(this.lastGlobal) || JSON.stringify(project) !== JSON.stringify(this.lastProject)) {
			this.generation += 1;
			this.lastGlobal = global;
			this.lastProject = project;
		}
		return { global, project, generation: this.generation };
	}

	async writeSchema(targetPath: string): Promise<void> {
		await mkdir(path.dirname(targetPath), { recursive: true });
		await writeFile(targetPath, `${JSON.stringify(permissionsSchema, null, "\t")}\n`, "utf8");
	}

	private globalPolicyPath(): string {
		return this.options.globalPolicyPath ?? path.join(defaultAgentDir(), "pi-permissions.jsonc");
	}
}

export function defaultAgentDir(): string {
	return process.env["PI_AGENT_DIR"] ?? process.env["O_PI_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
}

export function defaultProjectPolicyPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "permissions.jsonc");
}

async function loadPolicy(source: "global" | "project", filePath: string): Promise<LoadedPermissionPolicy> {
	if (filePath === "") return { source, path: filePath, status: "missing" };
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return { source, path: filePath, status: "invalid", error: "Policy path is not a file." };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { source, path: filePath, status: "missing" };
		}
		return { source, path: filePath, status: "load_failed", error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const text = await readFile(filePath, "utf8");
		const parsed = JSON.parse(stripJsonc(text)) as unknown;
		const validation = validatePolicyFile(parsed);
		if (!validation.ok) {
			return {
				source,
				path: filePath,
				status: "invalid",
				error: validation.errors.map((item) => `${item.pointer}: ${item.message}`).join("; "),
			};
		}
		return { source, path: filePath, status: "loaded", policy: validation.policy };
	} catch (error) {
		return { source, path: filePath, status: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
}

export function stripJsonc(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index] ?? "";
		const next = input[index + 1] ?? "";
		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "\"") {
				inString = false;
			}
			continue;
		}
		if (char === "\"") {
			inString = true;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < input.length && input[index] !== "\n") index += 1;
			output += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
			index += 1;
			continue;
		}
		output += char;
	}
	return output.replace(/,\s*([}\]])/g, "$1");
}

export const defaultPolicy: PermissionPolicyFile = {
	version: 1,
	defaults: {
		workspace: {
			ls: "allow",
			read: "allow",
			edit: "allow",
		},
		external: { "*": "ask" },
		system: {
			ls: "ask",
			read: "ask",
			edit: "deny",
		},
		sensitive: { "*": "deny" },
	},
};
