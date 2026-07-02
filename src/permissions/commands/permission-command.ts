import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { PermissionErrorCode } from "../permission-types.js";
import type { PermissionService } from "../permission-service.js";

export type PermissionOutputMode = "human" | "json";

/** parser 输出的稳定命令模型：路径、位置参数、flag 和原始文本分离。 */
export interface ParsedPermissionCommand {
	path: string[];
	positionals: string[];
	flags: Map<string, string | boolean>;
	raw: string;
}

/** 单次 /permissions 调用的运行时边界；handler 不缓存 Pi ctx。 */
export interface PermissionCommandContext {
	runtime: PermissionService;
	ctx: ExtensionCommandContext;
	interactive: boolean;
	outputMode: PermissionOutputMode;
	workspacePath: string;
	agentDir: string;
	signal?: AbortSignal;
}

/** 命令统一返回结构化 DTO，再由 renderer 输出 human 或 JSON。 */
export interface PermissionCommandResult<T = unknown> {
	command: string;
	data: T;
	human: string;
}

/** 权限控制台专用错误；JSON 模式直接使用 code 和 suggestions。 */
export class PermissionCommandError extends Error {
	constructor(
		readonly code: PermissionErrorCode,
		message: string,
		readonly suggestions: string[] = [],
	) {
		super(message);
	}
}

/** 返回用于输出 envelope 的稳定命令名。 */
export function commandName(parsed: ParsedPermissionCommand): string {
	return parsed.path.join(" ") || "console";
}

/** 判断布尔 flag 是否存在。 */
export function hasFlag(parsed: ParsedPermissionCommand, name: string): boolean {
	return parsed.flags.get(name) === true;
}

/** 读取字符串 flag 值。 */
export function flagValue(parsed: ParsedPermissionCommand, name: string): string | undefined {
	const value = parsed.flags.get(name);
	return typeof value === "string" ? value : undefined;
}
