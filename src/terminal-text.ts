import { stripVTControlCharacters } from "node:util";

const ANSI_SEQUENCE = /\u001b(?:\][^\u0007]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|\([0-~]|\)[0-~]|[PX^_].*?\u001b\\)/gs;

/** 清理 ANSI、OSC 和 APC 等终端控制序列，不加载 TUI。 */
export function stripTerminalSequences(value: string): string {
	return stripVTControlCharacters(value.replace(ANSI_SEQUENCE, ""));
}
