import type { GuiToolOutput, ToolOutput } from "./types.ts";

/** 进度引用附带版本，同一载荷位置始终读取最新值。 */
export function payloadKey(id: string): string {
	const separator = id.indexOf("/");
	return separator < 0 ? id : id.slice(0, separator);
}

export function outputPreview(output: GuiToolOutput | undefined): ToolOutput | undefined {
	return output?.kind === "inline" ? output.value : output?.preview;
}
