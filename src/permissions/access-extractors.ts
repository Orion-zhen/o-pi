import type { EditOperation, EditOperationType } from "../file-tools/types.js";
import type { PermissionAccess, PermissionAction, ResolvedPermissionPath } from "./permission-types.js";
import { ResourceResolver } from "./resource-resolver.js";

export function operationAction(type: EditOperationType): PermissionAction {
	if (type === "create_file") return "fs.create";
	if (type === "update_file") return "fs.update";
	if (type === "replace_file") return "fs.replace";
	if (type === "delete_file") return "fs.delete";
	return "fs.move";
}

export async function accessForPath(resolver: ResourceResolver, action: PermissionAction, inputPath: string): Promise<PermissionAccess> {
	return accessFromResolved(action, await resolver.resolve(inputPath));
}

export async function accessesForEdit(resolver: ResourceResolver, operations: EditOperation[]): Promise<PermissionAccess[]> {
	const accesses: PermissionAccess[] = [];
	for (const operation of operations) {
		if (operation.type === "move_file") {
			const source = await resolver.resolve(operation.from);
			const target = await resolver.resolve(operation.to);
			accesses.push({
				...accessFromResolved("fs.move", source),
				sourcePath: source.canonicalPath,
				destinationPath: target.canonicalPath,
			});
			accesses.push({
				...accessFromResolved("fs.move", target),
				sourcePath: source.canonicalPath,
				destinationPath: target.canonicalPath,
			});
			continue;
		}
		accesses.push(accessFromResolved(operationAction(operation.type), await resolver.resolve(operation.path)));
	}
	return accesses;
}

export function accessFromResolved(action: PermissionAction, resolved: ResolvedPermissionPath): PermissionAccess {
	return {
		action,
		inputPath: resolved.inputPath,
		absolutePath: resolved.absolutePath,
		canonicalPath: resolved.canonicalPath,
		displayPath: resolved.workspaceRelativePath ?? resolved.canonicalPath,
		boundary: resolved.boundary,
		targetType: resolved.type,
		exists: resolved.exists,
		viaSymlink: resolved.viaSymlink,
		...(resolved.identity !== undefined ? { identity: resolved.identity } : {}),
		...(resolved.canonicalParentIdentity !== undefined ? { canonicalParentIdentity: resolved.canonicalParentIdentity } : {}),
	};
}
