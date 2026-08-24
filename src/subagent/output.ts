import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findNearestProjectRoot } from "../config-loader.js";
import { countTextTokensSync, type TokenCounterScope } from "../token-counter.js";
import type { SubagentCompletedResult, UnpersistedSubagentRunResult } from "./types.js";

const RUNS_DIR = path.join(".pi", "subagents", "runs");

export interface OutputFormatOptions {
	cwd: string;
	runId: string;
	index: number;
}

export async function persistResult(result: UnpersistedSubagentRunResult, options: OutputFormatOptions): Promise<SubagentCompletedResult> {
	const runDir = getRunDir(options.cwd, options.runId);
	await mkdir(runDir, { recursive: true });
	const base = `${sanitizeFileName(result.agent)}-${options.index + 1}`;
	const completed: SubagentCompletedResult = { ...result, outputFile: path.join(runDir, `${base}.md`) };
	await writePrivateFile(completed.outputFile, completed.output);
	await writePrivateFile(path.join(runDir, `${base}.json`), JSON.stringify(completed, null, 2));
	return completed;
}

export function formatResultForContext(result: SubagentCompletedResult, maxInlineOutputTokens: number, tokenScope: TokenCounterScope = {}): string {
	if (!exceedsTokenLimit(result.output, maxInlineOutputTokens, tokenScope)) return result.output;
	return `Subagent ${result.agent} produced too much output for inline return; full output saved to ${result.outputFile}.`;
}

export function formatFileHandoff(result: SubagentCompletedResult): string {
	return `Previous subagent ${result.agent} output exceeded the handoff limit; full output saved to ${result.outputFile}. Read that file for the complete result.`;
}

export function exceedsTokenLimit(input: string, maxTokens: number, tokenScope: TokenCounterScope = {}): boolean {
	return countTextTokensSync(input, tokenScope).tokens > maxTokens;
}

export function getRunDir(cwd: string, runId: string): string {
	const root = findNearestProjectRoot(cwd) ?? cwd;
	return path.join(root, RUNS_DIR, runId);
}

export function sanitizeFileName(name: string): string {
	return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/^\.+$/, "_").slice(0, 80);
}

function writePrivateFile(filePath: string, content: string): Promise<void> {
	return writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
}
