import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { findNearestProjectRoot } from "./config.js";
import type { OutputMode, SubagentRunResult } from "./types.js";

export interface OutputFormatOptions {
	cwd: string;
	runId: string;
	index: number;
	outputMode: OutputMode;
	maxInlineOutputChars: number;
}

/** 按 Unicode code point 截断，避免把代理对切坏。 */
export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
	const chars = [...input];
	if (chars.length <= maxChars) return { text: input, truncated: false };
	const kept = chars.slice(0, Math.max(0, maxChars)).join("");
	return {
		text: `${kept}\n\n[Subagent output truncated: ${chars.length - maxChars} chars omitted. Full output saved in run files.]`,
		truncated: true,
	};
}

export function limitHandoff(input: string, maxChars: number): string {
	return truncateText(input, maxChars).text;
}

export async function persistResult(result: SubagentRunResult, options: OutputFormatOptions): Promise<SubagentRunResult> {
	const runDir = getRunDir(options.cwd, options.runId);
	await mkdir(runDir, { recursive: true });
	const base = `${sanitizeFileName(result.agent)}-${options.index + 1}`;
	const outputFile = path.join(runDir, `${base}.md`);
	const metadataFile = path.join(runDir, `${base}.json`);
	await atomicWrite(outputFile, result.output ?? "");
	await atomicWrite(metadataFile, JSON.stringify(result, null, 2));
	return { ...result, outputFile };
}

export function formatResultForContext(result: SubagentRunResult, mode: OutputMode, maxInlineOutputChars: number): string {
	const output = result.output ?? "";
	if (mode === "file" && result.outputFile !== undefined) {
		const preview = truncateText(output, Math.min(1200, maxInlineOutputChars)).text;
		return [
			"Subagent result saved to:",
			result.outputFile,
			"",
			`Agent: ${result.agent}`,
			`Size: ${formatBytes(Buffer.byteLength(output, "utf8"))}`,
			"Preview:",
			preview,
		].join("\n");
	}
	return truncateText(output, maxInlineOutputChars).text;
}

export function formatFileHandoff(result: SubagentRunResult): string {
	if (result.outputFile === undefined) return limitHandoff(result.output ?? "", 2000);
	const size = Buffer.byteLength(result.output ?? "", "utf8");
	const preview = truncateText(result.output ?? "", 1200).text;
	return [`Previous subagent result: ${result.outputFile}`, `Agent: ${result.agent}`, `Size: ${formatBytes(size)}`, "Preview:", preview].join("\n");
}

export function getRunDir(cwd: string, runId: string): string {
	const root = findNearestProjectRoot(cwd) ?? cwd;
	return path.join(root, ".pi", "subagents", "runs", runId);
}

export function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/^\.+$/, "_");
	return cleaned.length === 0 ? "agent" : cleaned.slice(0, 80);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
	await rename(tempPath, filePath);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
