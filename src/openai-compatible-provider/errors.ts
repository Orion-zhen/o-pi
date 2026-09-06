/** 统一配置文件路径和错误原因的展示格式。 */
export function invalidModelsJsonc(path: string, reason: string): Error {
	return new Error(`Invalid ${path}:\n${reason}`);
}
