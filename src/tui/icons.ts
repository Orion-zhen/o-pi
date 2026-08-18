import type { TuiIconMode } from "./types.js";

export type ToolCardStatus = "running" | "success" | "error" | "warning" | "neutral";
export type TuiIconName = "git";

type ResolvedIconMode = "ascii" | "unicode" | "nerd";

const toolStatusIcons: Record<ResolvedIconMode, Record<ToolCardStatus, string>> = {
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

const tuiIcons: Record<ResolvedIconMode, Record<TuiIconName, string>> = {
	ascii: { git: "git" },
	unicode: { git: "⑂" },
	nerd: { git: "" },
};

let currentMode: TuiIconMode = "unicode";

/** 设置 TUI 各组件共享的图标模式；auto 使用不会依赖补丁字体的 Unicode。 */
export function configureTuiIconMode(mode: TuiIconMode): void {
	currentMode = mode;
}

export function getTuiIconMode(): TuiIconMode {
	return currentMode;
}

/** 返回统一图标表中的界面图标。 */
export function tuiIcon(name: TuiIconName, mode: TuiIconMode = currentMode): string {
	return tuiIcons[resolveMode(mode)][name];
}

/** 返回与全局图标模式一致的工具状态图标。 */
export function statusIcon(status: ToolCardStatus, mode: TuiIconMode = currentMode): string {
	return toolStatusIcons[resolveMode(mode)][status];
}

function resolveMode(mode: TuiIconMode): ResolvedIconMode {
	return mode === "auto" ? "unicode" : mode;
}
