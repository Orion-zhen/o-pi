import path from "node:path";
import type { Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { statusIcon } from "./icons.js";
import type { TuiConfig, TuiFooterSnapshot } from "./types.js";
import { joinParts } from "./text.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 根据配置生成 Pi 内置 working indicator 配置。 */
export function workingIndicatorOptions(config: TuiConfig, theme: Pick<Theme, "fg">): WorkingIndicatorOptions | undefined {
	if (config.chrome.working_indicator === "off") return { frames: [] };
	if (config.chrome.working_indicator === "dot") return { frames: [theme.fg("warning", statusIcon("running", config.icons))] };
	if (config.chrome.working_indicator === "spinner") return { frames: SPINNER_FRAMES.map((frame) => theme.fg("warning", frame)), intervalMs: 80 };
	return undefined;
}

/** 终端 title 只使用真实可得数据，不伪造模型、token 或成本。 */
export function formatTitle(snapshot: TuiFooterSnapshot): string {
	const cwd = snapshot.cwd ? path.basename(snapshot.cwd) : "o-pi";
	return joinParts(["π o-pi", cwd, snapshot.git, snapshot.modelId, snapshot.status], " · ");
}

/** 可选 header 是单行轻 chrome；默认配置关闭，避免重写 Pi 主 TUI。 */
export function createHeaderComponent(getSnapshot: () => TuiFooterSnapshot): (_tui: unknown, theme: Theme) => Text {
	return (_tui, theme) => new Text(theme.fg("dim", formatTitle(getSnapshot())), 0, 0);
}
