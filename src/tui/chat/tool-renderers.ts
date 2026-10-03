import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { renderBashCall } from "./bash-tool/renderer.ts";
import {
	renderLsCall, renderLsResult, renderFindCall, renderFindResult, renderGrepCall, renderGrepResult,
	renderReadCall, renderReadResult, renderWriteCall, renderWriteResult, renderEditCall, renderEditResult,
} from "./file-tools/index.ts";
import { registerSkillMessageRenderer, renderSkillCall, renderSkillResult } from "./skill-context/renderer.ts";
import {
	renderSubagentCall, renderSubagentResult, renderSubagentCommandEntry, SUBAGENT_COMMAND_ENTRY,
} from "./subagent/renderer.ts";
import { renderWebFetchCall, renderWebFetchResult } from "./web-tools/webfetch.ts";
import { renderWebSearchCall, renderWebSearchResult } from "./web-tools/websearch.ts";

const renderers = new Map<string, ToolRenderers>([
	["ls", { renderCall: renderLsCall, renderResult: renderLsResult }],
	["find", { renderCall: renderFindCall, renderResult: renderFindResult }],
	["grep", { renderCall: renderGrepCall, renderResult: renderGrepResult }],
	["read", { renderCall: renderReadCall, renderResult: renderReadResult }],
	["write", { renderCall: renderWriteCall, renderResult: renderWriteResult }],
	["edit", { renderShell: "self", renderCall: renderEditCall, renderResult: renderEditResult }],
	["bash", { renderCall: renderBashCall }],
	["websearch", { renderCall: renderWebSearchCall, renderResult: renderWebSearchResult }],
	["webfetch", { renderCall: renderWebFetchCall, renderResult: renderWebFetchResult }],
	["skill", {
		renderCall: renderSkillCall,
		renderResult: (result, options, theme, context) => renderSkillResult(result.details, options, theme, context),
	}],
	["subagent", { renderCall: renderSubagentCall, renderResult: renderSubagentResult }],
]);

/** 展示独立于执行定义，未覆盖的插槽继续使用 SDK 或其他扩展的呈现器。 */
export function registerToolRenderers(pi: Pick<ExtensionAPI, "registerToolRenderer" | "registerMessageRenderer" | "registerEntryRenderer">): void {
	pi.registerToolRenderer((name, next) => {
		const base = next();
		const renderer = renderers.get(name);
		return renderer === undefined ? base : { ...base, ...renderer };
	});
	registerSkillMessageRenderer(pi);
	pi.registerEntryRenderer(SUBAGENT_COMMAND_ENTRY, (entry, { expanded }, theme) => (
		renderSubagentCommandEntry(entry.data, expanded, theme)
	));
}
