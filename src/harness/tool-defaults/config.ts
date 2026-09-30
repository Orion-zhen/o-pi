import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { replaceConfigFile } from "../config-file.ts";
import { isNotFound } from "../config-loader.ts";

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
	await replaceConfigFile(filePath, original, JSON.stringify({ ...settings, defaultTools: tools }, null, 2) + "\n");
	return filePath;
}
