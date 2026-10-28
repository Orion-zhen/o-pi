import type { McpExposure } from "@earendil-works/pi-coding-agent";

const labels = {
	codemode: "脚本与按需发现",
	deferred: "搜索后加载",
	direct: "始终提供给模型",
	hidden: "隐藏",
} satisfies Record<McpExposure, string>;

export function McpExposureLabel({ exposure }: { exposure: McpExposure }) {
	return <span className="mcp-exposure">{labels[exposure]}(<code>{exposure}</code>)</span>;
}
