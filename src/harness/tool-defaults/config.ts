import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { replaceConfigFile } from "../config-file.ts";
import { isNotFound } from "../config-loader.ts";
import { isSearchModifier, toolEntries } from "./initial.ts";

/** 将当前选择写入 Pi 原生字段，默认值解析交给 SDK。 */
export async function saveUserToolDefaults(tools: readonly string[]): Promise<string> {
	const filePath = path.join(getAgentDir(), "settings.json");
	let original: string;
	try {
		original = await readFile(filePath, "utf8");
	} catch (error) {
		if (!isNotFound(error)) throw error;
		original = "";
	}
	const errors: ParseError[] = [];
	const settings: unknown = parse(original.replace(/^\uFEFF/, "") || "{}", errors, { allowTrailingComma: true });
	const error = errors[0];
	if (error) throw new Error(`settings.json: ${printParseErrorCode(error.error)} @${error.offset}`);
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		throw new Error("settings.json must be an object.");
	}
	const entries = "defaultTools" in settings ? toolEntries(settings.defaultTools) : undefined;
	const search = entries?.filter((entry) => entry === "tool_search" || isSearchModifier(entry)) ?? [];
	// 只有 +/- 项时 SDK 会继承默认工具。保存空选择时用搜索入口作为唯一的基础工具。
	const base = tools.length === 0 && search.length > 0 && !search.includes("tool_search") ? ["tool_search"] : tools;
	await replaceConfigFile(filePath, original, JSON.stringify({ ...settings, defaultTools: [...base, ...search] }, null, 2) + "\n");
	return filePath;
}
