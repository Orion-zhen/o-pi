import type { GuiToolOutput, GuiToolResult, ToolOutput } from "./types.ts";

/** 进度引用附带版本，同一载荷位置始终读取最新值。 */
export function payloadKey(id: string): string {
	const separator = id.indexOf("/");
	return separator < 0 ? id : id.slice(0, separator);
}

export function outputPreview(output: GuiToolOutput | undefined): GuiToolResult | undefined {
	return output?.kind === "inline" ? output.value : output?.preview;
}

/** 展示元数据不混入原始结果检查器。 */
export function rawToolOutput({ view: _view, facts: _facts, error: _error, aborted: _aborted, ...output }: GuiToolResult): ToolOutput {
	return output;
}
