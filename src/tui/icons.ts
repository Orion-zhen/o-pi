import type { TuiIconMode } from "./types.js";

export type ToolCardStatus = "running" | "success" | "error" | "warning" | "neutral";
export type TuiIconName = "git";

const toolStatusIcons: Record<TuiIconMode, Record<ToolCardStatus, string>> = {
	ascii: {
		running: "*",
		success: "+",
		error: "x",
		warning: "!",
		neutral: "-",
	},
	unicode: {
		running: "●",
		success: "✓",
		error: "✕",
		warning: "!",
		neutral: "·",
	},
	nerd: {
		running: "",
		success: "",
		error: "",
		warning: "",
		neutral: "",
	},
};

const tuiIcons: Record<TuiIconMode, Record<TuiIconName, string>> = {
	ascii: { git: "git" },
	unicode: { git: "⑂" },
	nerd: { git: "" },
};

let currentMode: TuiIconMode = "unicode";

/** 设置 TUI 各组件共享的图标模式。 */
export function configureTuiIconMode(mode: TuiIconMode): void {
	currentMode = mode;
}

export function getTuiIconMode(): TuiIconMode {
	return currentMode;
}

/** 返回统一图标表中的界面图标。 */
export function tuiIcon(name: TuiIconName, mode: TuiIconMode = currentMode): string {
	return tuiIcons[mode][name];
}

/** 返回与全局图标模式一致的工具状态图标。 */
export function statusIcon(status: ToolCardStatus, mode: TuiIconMode = currentMode): string {
	return toolStatusIcons[mode][status];
}
