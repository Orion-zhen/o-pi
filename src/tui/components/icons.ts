import type { TuiIconMode } from "../shell/types.js";

export type ToolCardStatus = "running" | "success" | "error" | "warning" | "neutral";
type TuiIconName = "git";

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

/** 返回统一图标表中的界面图标。 */
export function tuiIcon(name: TuiIconName): string {
	return tuiIcons[currentMode][name];
}

/** 返回与全局图标模式一致的工具状态图标。 */
export function statusIcon(status: ToolCardStatus): string {
	return toolStatusIcons[currentMode][status];
}
