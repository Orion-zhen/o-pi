import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { joinParts } from "./text.js";
import type { TuiSnapshot } from "../shell/types.js";

/** $HOME 下使用 ~，保留路径边界，避免把相似前缀误认为子目录。 */
export function formatWorkspace(cwd: string): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"];
	if (!home) return cwd;
	const relative = path.relative(path.resolve(home), path.resolve(cwd));
	const insideHome = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	if (!insideHome) return cwd;
	return relative === "" ? "~" : `~/${relative.split(path.sep).join("/")}`;
}

export function formatProject(snapshot: TuiSnapshot, theme: Pick<Theme, "fg">): string {
	return joinParts([
		theme.fg("accent", formatWorkspace(snapshot.cwd)),
		snapshot.git ? theme.fg("success", snapshot.git) : undefined,
	], theme.fg("dim", " · "));
}

export function formatModel(snapshot: TuiSnapshot): string | undefined {
	if (!snapshot.modelId) return undefined;
	let label = snapshot.modelId;
	if (snapshot.modelReasoning) {
		label += snapshot.thinkingLevel === "off" ? " • thinking off" : ` • ${snapshot.thinkingLevel}`;
	}
	return snapshot.availableProviderCount > 1 && snapshot.modelProvider ? `(${snapshot.modelProvider}) ${label}` : label;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}
