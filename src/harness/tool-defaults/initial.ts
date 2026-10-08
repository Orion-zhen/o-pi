import { SettingsManager, type Args, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";

export type ToolStartupOptions = Pick<Args, "tools" | "noTools" | "noBuiltinTools">;

/** 保留注册时的默认启用行为，仅应用显式配置和 CLI 增减。 */
export function initialToolDefaults(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getSettings">,
	branch: readonly SessionEntry[],
	options: ToolStartupOptions,
): string[] | undefined {
	if (options.noTools || options.noBuiltinTools || options.tools?.some((name) => !isModifier(name))) return undefined;
	if (branch.some((entry) => entry.type === "message" && entry.message.role === "system"
		&& (entry.message.toolsAdded !== undefined || entry.message.toolsRemoved !== undefined))) return undefined;
	const configured = pi.getSettings().defaultTools;
	if (configured === undefined && options.tools === undefined) return undefined;
	// 纯增减作用于已自动启用的工具，显式列表（包括空列表）由 SDK 原样解析。
	const entries = configured === undefined || (Array.isArray(configured) && configured.length > 0 && configured.every(isModifier))
		? [...pi.getActiveTools(), ...configured ?? []]
		: configured;
	const defaults = SettingsManager.inMemory({ defaultTools: entries }).getDefaultTools();
	return options.tools === undefined ? defaults
		: SettingsManager.inMemory({ defaultTools: [...defaults ?? [], ...options.tools] }).getDefaultTools();
}

function isModifier(name: unknown): boolean {
	return typeof name === "string" && (name.startsWith("+") || name.startsWith("-"));
}
