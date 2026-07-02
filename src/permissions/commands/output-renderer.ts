import { commandName, type ParsedPermissionCommand, type PermissionCommandResult } from "./permission-command.js";

/** JSON 模式的唯一输出 envelope；错误也复用该结构。 */
export interface JsonPermissionEnvelope {
	schemaVersion: 1;
	ok: boolean;
	command: string;
	data?: unknown;
	error?: {
		code: string;
		message: string;
		suggestions?: string[];
	};
}

/** 人类输出只处理展示；命令逻辑返回 DTO。 */
export class HumanPermissionRenderer {
	render(result: PermissionCommandResult): string {
		return result.human;
	}
}

/** JSON 输出稳定为单个 value，不混入 ANSI 或说明文本。 */
export class JsonPermissionRenderer {
	render(result: PermissionCommandResult): string {
		return JSON.stringify(
			{
				schemaVersion: 1,
				ok: true,
				command: result.command,
				data: result.data,
			} satisfies JsonPermissionEnvelope,
			null,
			"\t",
		);
	}

	renderError(parsed: ParsedPermissionCommand | undefined, error: { code: string; message: string; suggestions?: string[] }): string {
		const envelope: JsonPermissionEnvelope = {
			schemaVersion: 1,
			ok: false,
			command: parsed === undefined ? "permissions" : commandName(parsed),
			error: error.suggestions === undefined ? { code: error.code, message: error.message } : error,
		};
		return JSON.stringify(envelope, null, "\t");
	}
}
