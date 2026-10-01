import { createToolSearchExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { syncToolSearch } from "../tool-search/loadout.ts";

/** 保留原生 schema 身份、搜索和结果，启停由会话模式与候选集合决定。 */
export default function toolSearch(pi: ExtensionAPI): void {
	createToolSearchExtension()(pi);
	const sync = () => { syncToolSearch(pi); };
	pi.on("session_start", sync);
	pi.on("session_tree", sync);
	pi.on("before_agent_start", sync);
	pi.on("turn_start", sync);
	pi.on("tool_result", sync);
}
