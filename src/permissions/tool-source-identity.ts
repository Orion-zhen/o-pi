import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { PermissionSubject } from "./permission-types.js";

interface PackageInfo {
	name: string;
	version: string;
	manifestIdentity?: string;
}

/** 基于 Pi 实际注册来源生成授权主体身份；路径、包版本和文件内容变化都会使旧 grant 失效。 */
export async function toolSourceFromInfo(tool: ToolInfo): Promise<PermissionSubject["source"]> {
	const sourcePath = await normalizedSourcePath(tool.sourceInfo);
	const packageInfo = await packageInfoFor(sourcePath);
	const contentHash = await sourceContentHash(sourcePath);
	const identity = stableHash({
		path: sourcePath,
		packageName: packageInfo.name,
		packageVersion: packageInfo.version,
		contentHash,
		...(packageInfo.manifestIdentity !== undefined ? { manifestIdentity: packageInfo.manifestIdentity } : {}),
	});
	return {
		type: tool.sourceInfo.source === "builtin" ? "builtin" : "extension",
		name: packageInfo.name === "local" ? tool.sourceInfo.source : packageInfo.name,
		identity,
	};
}

async function normalizedSourcePath(sourceInfo: SourceInfo): Promise<string> {
	if (sourceInfo.path.startsWith("<") && sourceInfo.path.endsWith(">")) return sourceInfo.path;
	const candidates = pathCandidates(sourceInfo);
	for (const candidate of candidates) {
		if (await canRead(candidate)) return normalizePath(await realpath(candidate));
	}
	return normalizePath(candidates[0] ?? sourceInfo.path);
}

function pathCandidates(sourceInfo: SourceInfo): string[] {
	if (path.isAbsolute(sourceInfo.path)) return [path.resolve(sourceInfo.path)];
	const candidates: string[] = [];
	if (sourceInfo.baseDir !== undefined) {
		candidates.push(path.resolve(sourceInfo.baseDir, sourceInfo.path));
		candidates.push(path.resolve(sourceInfo.baseDir, path.basename(sourceInfo.path)));
	}
	candidates.push(path.resolve(sourceInfo.path));
	return Array.from(new Set(candidates));
}

async function packageInfoFor(sourcePath: string): Promise<PackageInfo> {
	if (sourcePath.startsWith("<")) return { name: "pi", version: "builtin" };
	const packagePath = await findPackageJson(path.dirname(sourcePath));
	if (packagePath === undefined) return { name: "local", version: "0" };
	try {
		const parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
		if (!isPackageJson(parsed)) return { name: "local", version: "0" };
		const manifestIdentity = manifestIdentityFrom(parsed.pi);
		return {
			name: parsed.name ?? "local",
			version: parsed.version ?? "0",
			...(manifestIdentity !== undefined ? { manifestIdentity } : {}),
		};
	} catch {
		return { name: "local", version: "0" };
	}
}

async function findPackageJson(startDir: string): Promise<string | undefined> {
	let current = path.resolve(startDir);
	while (true) {
		const candidate = path.join(current, "package.json");
		if (await canRead(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function sourceContentHash(sourcePath: string): Promise<string> {
	if (sourcePath.startsWith("<")) return `virtual:${sourcePath}`;
	try {
		return createHash("sha256").update(await readFile(sourcePath)).digest("hex");
	} catch {
		return "unreadable";
	}
}

async function canRead(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function manifestIdentityFrom(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if ("identity" in value && typeof value.identity === "string" && value.identity.trim() !== "") return value.identity;
	if ("manifestIdentity" in value && typeof value.manifestIdentity === "string" && value.manifestIdentity.trim() !== "") return value.manifestIdentity;
	return undefined;
}

function isPackageJson(value: unknown): value is { name?: string; version?: string; pi?: unknown } {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; version?: unknown; pi?: unknown };
	return (candidate.name === undefined || typeof candidate.name === "string") && (candidate.version === undefined || typeof candidate.version === "string");
}

function stableHash(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}
