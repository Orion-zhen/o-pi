import path from "node:path";

import { canCreatePersistentGrant } from "./grants.js";
import type { AuthorizationRequest, CompiledDecision, PermissionOperation, PermissionResource, ResolvedFileResource } from "./permission-types.js";

/** 渲染给用户审批用的完整决策上下文；不包含文件内容、diff、环境变量或 prompt。 */
export function renderPermissionApprovalPrompt(request: AuthorizationRequest, decision: CompiledDecision): string {
	return [
		`Tool: ${request.subject.configKey}`,
		`Source: ${request.subject.source.type} ${request.subject.source.name}`,
		`Identity: ${request.subject.source.identity ?? "none"}`,
		"",
		"Requested operations:",
		...renderRequestedOperations(request.resources),
		"",
		"Reason:",
		`  ${decision.trace.at(-1)?.message ?? request.summary}`,
		"",
		"Policy trace:",
		...decision.trace.map((entry) => `  ${entry.source} ${entry.message} ${entry.effect}${entry.ruleId === undefined ? "" : ` (${entry.ruleId})`}`),
		"",
		"Grant effects:",
		"  Allow once: current request only",
		"  Allow exact for session: exact resources until session ends",
		...renderSubtreeGrantEffects(request.resources),
		`  Always allow: ${canCreatePersistentGrant(request) ? "persistent grant; survives session and binds this source identity" : "not available for this request"}`,
		"",
		...renderSymlinkInformation(request.resources),
	].join("\n");
}

function renderRequestedOperations(resources: PermissionResource[]): string[] {
	if (resources.length === 0) return ["  - invoke subject without structured resources"];
	return resources.flatMap((resource) => {
		if (resource.kind === "file") return renderFileOperation(resource);
		if (resource.kind === "command") return [`  - execute ${resource.command}`];
		if (resource.kind === "mcp") return [`  - invoke mcp ${resource.server}/${resource.tool}`];
		if (resource.kind === "skill") return [`  - load skill ${resource.name}`];
		if (resource.kind === "agent") return [`  - spawn agent ${resource.name}`];
		return [`  - ${resource.label}`];
	});
}

function renderFileOperation(file: ResolvedFileResource): string[] {
	const lines = [`  - ${operationLabel(file.operation)} ${file.canonicalPath} (${file.access})`];
	if (file.inputPath !== file.canonicalPath) lines.push(`    input: ${file.inputPath}`);
	if (file.lexicalAbsolutePath !== file.canonicalPath) lines.push(`    lexical: ${file.lexicalAbsolutePath}`);
	lines.push(`    canonical: ${file.canonicalPath}`);
	lines.push(`    exists: ${file.exists ? "yes" : "no"}; type: ${file.targetType}`);
	return lines;
}

function renderSubtreeGrantEffects(resources: PermissionResource[]): string[] {
	const files = resources.filter((resource): resource is ResolvedFileResource => resource.kind === "file");
	if (files.length === 0) return ["  Allow subtree for session: not available"];
	return [
		"  Allow subtree for session: these canonical directories until session ends",
		...files.map((file) => `    - ${subtreePath(file)} (${file.access}, ${operationLabel(file.operation)})`),
	];
}

function renderSymlinkInformation(resources: PermissionResource[]): string[] {
	const files = resources.filter((resource): resource is ResolvedFileResource => resource.kind === "file" && resource.viaSymlink);
	if (files.length === 0) return ["Symlink information:", "  none"];
	return [
		"Symlink information:",
		...files.flatMap((file) => {
			const chain = file.symlinkChain.length > 0 ? file.symlinkChain : [file.lexicalAbsolutePath, file.canonicalPath];
			return [`  ${chain.join(" -> ")}`];
		}),
	];
}

function subtreePath(file: ResolvedFileResource): string {
	return file.targetType === "directory" ? file.canonicalPath : path.dirname(file.canonicalPath);
}

function operationLabel(operation: PermissionOperation): string {
	if (operation === "file.list") return "list";
	if (operation === "file.read") return "read";
	if (operation === "file.create") return "create";
	if (operation === "file.update") return "update";
	if (operation === "file.replace") return "replace";
	if (operation === "file.delete") return "delete";
	if (operation === "file.move") return "move";
	if (operation === "process.execute") return "execute";
	if (operation === "mcp.invoke") return "invoke";
	if (operation === "skill.load") return "load";
	return "spawn";
}
