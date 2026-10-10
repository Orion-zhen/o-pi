import type { McpExposure } from "@earendil-works/pi-coding-agent";
import { mcpExposures } from "../../mcp-validation.ts";

const labels = {
	codemode: "脚本与按需发现",
	deferred: "搜索后加载",
	direct: "始终提供给模型",
	hidden: "隐藏",
} satisfies Record<McpExposure, string>;

export function McpExposureLabel({ exposure, defaultHint = false }: { exposure: McpExposure; defaultHint?: boolean }) {
	return <span className="mcp-exposure">{labels[exposure]}(<code>{exposure}</code>){defaultHint && exposure === "codemode" && " - 默认"}</span>;
}

export const exposureOptions = mcpExposures.map((exposure) => [exposure, <McpExposureLabel key={exposure} exposure={exposure} defaultHint />] as const);
