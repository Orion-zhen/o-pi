import { getCurrentTools } from "@earendil-works/pi-ai";
import type { Args, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { applyToolModifiers, isToolModifier } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

import { DEFAULT_SHELL_TOOL } from "../shell-runtime/platform.ts";

export type ToolStartupOptions = Pick<Args, "tools" | "noTools" | "noBuiltinTools">;

/** SDK 的原始 settings 没有校验。与 getDefaultTools 一致，非数组按空列表处理。 */
export function toolEntries(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isSearchModifier(entry: string): boolean {
	return entry === "+tool_search" || entry === "-tool_search";
}

export function resolveToolDefaults(active: readonly string[], entries: readonly string[] | undefined, cli: readonly string[] = []): string[] {
	if (entries === undefined) return applyToolModifiers(active, cli);
	const names = entries.filter((name) => !isToolModifier(name));
	// 显式列表（包括空列表）替换可选工具，但不关闭自动搜索入口。
	const base = entries.length === 0 || names.length > 0 ? [...active.filter((name) => name === "tool_search"), ...names] : active;
	return applyToolModifiers([...new Set(base)], [...entries, ...cli]);
}

export function sessionToolSelection(pi: Pick<ExtensionAPI, "getActiveTools" | "getSettings">, options: ToolStartupOptions,
	branch: readonly SessionEntry[], event: "session_start" | "session_tree"): string[] {
	const active = pi.getActiveTools();
	if (options.noTools || options.noBuiltinTools || options.tools?.some((name) => !isToolModifier(name))) return active;
	const entries = toolEntries(pi.getSettings().defaultTools);
	const history = branch.flatMap((entry) => entry.type === "message" && entry.message.role === "system" ? [entry.message] : []);
	if (!history.length) {
		// 仅启动时移除 SDK 默认加入的 bash。导航时 active 是会话的当前选择。
		const base = event === "session_start" && DEFAULT_SHELL_TOOL !== "bash" ? active.filter((name) => name !== "bash") : active;
		return resolveToolDefaults(base, entries, options.tools);
	}

	// 有 system 消息却没有工具增删，也可能是一次真正的空选择。
	const recorded = new Set(getCurrentTools(history).map(({ name }) => name));
	if (active.includes("tool_search")) recorded.add("tool_search");
	return applyToolModifiers([...recorded], [...entries?.filter(isSearchModifier) ?? [], ...options.tools ?? []]);
}
