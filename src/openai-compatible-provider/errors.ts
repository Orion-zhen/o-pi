/** models.jsonc 配置错误；message 已包含面向用户的文件路径和具体配置路径。 */
export class ModelsJsoncConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelsJsoncConfigError";
	}
}

/** 构造统一的 models.jsonc 错误前缀，避免调用方重复拼接文件名。 */
export function invalidModelsJsonc(path: string, reason: string): ModelsJsoncConfigError {
	return new ModelsJsoncConfigError(`Invalid ${path}:\n${reason}`);
}
