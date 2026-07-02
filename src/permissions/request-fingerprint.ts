import { createHash } from "node:crypto";

import type { PermissionAccess } from "./permission-types.js";

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function stableFingerprint(value: unknown): string {
	return `sha256:${sha256Hex(stableSerialize(value))}`;
}

export function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
		.join(",")}}`;
}

export function accessFingerprintShape(accesses: PermissionAccess[]): unknown[] {
	return [...accesses]
		.sort((left, right) => {
			const byAction = left.action.localeCompare(right.action);
			if (byAction !== 0) return byAction;
			return left.canonicalPath.localeCompare(right.canonicalPath);
		})
		.map((access) => ({
			action: access.action,
			canonicalPath: access.canonicalPath,
			absolutePath: access.absolutePath,
			boundary: access.boundary,
			exists: access.exists,
			targetType: access.targetType,
			viaSymlink: access.viaSymlink,
			sourcePath: access.sourcePath,
			destinationPath: access.destinationPath,
			identity: access.identity,
			canonicalParentIdentity: access.canonicalParentIdentity,
		}));
}
