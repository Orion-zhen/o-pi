import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuthorizationLease, AuthorizationRequest, FileAccess, PermissionOperation, PermissionResource, PermissionSubject, ResolvedFileResource } from "./permission-types.js";
import { identityEquals, isPathInside } from "./path-utils.js";

export type GrantScope =
	| {
			kind: "file-exact";
			path: string;
			operation: PermissionOperation;
			access: FileAccess;
	  }
	| {
			kind: "file-subtree";
			path: string;
			operations: PermissionOperation[];
			access: FileAccess;
	  }
	| {
			kind: "command-exact";
			commandFingerprint: string;
	  }
	| {
			kind: "mcp-tool";
			server: string;
			tool: string;
	  }
	| {
			kind: "subject";
			subjectId: string;
	  };

export interface Grant {
	id: string;
	subjectId: string;
	subjectIdentity?: string;
	scopes: GrantScope[];
	createdAt: number;
	status: "active" | "suspended";
}

export class LeaseStore {
	private readonly leases = new Map<string, AuthorizationLease>();

	add(request: AuthorizationRequest): AuthorizationLease {
		const lease: AuthorizationLease = {
			id: `lease_${randomUUID()}`,
			requestId: request.requestId,
			...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
			subjectId: request.subject.id,
			...(request.subject.source.identity !== undefined ? { subjectIdentity: request.subject.source.identity } : {}),
			inputFingerprint: request.inputFingerprint,
			resourceFingerprints: request.resources.map(resourceFingerprint),
			policyGeneration: request.policyGeneration,
			createdAt: Date.now(),
			consumed: false,
		};
		this.leases.set(lease.id, lease);
		return lease;
	}

	find(request: AuthorizationRequest): AuthorizationLease | undefined {
		return [...this.leases.values()].find(
			(lease) =>
				!lease.consumed &&
				lease.toolCallId === request.toolCallId &&
				lease.subjectId === request.subject.id &&
				lease.inputFingerprint === request.inputFingerprint &&
				lease.policyGeneration === request.policyGeneration &&
				sameSet(lease.resourceFingerprints, request.resources.map(resourceFingerprint)),
		);
	}

	consume(lease: AuthorizationLease): void {
		const stored = this.leases.get(lease.id);
		if (stored !== undefined) stored.consumed = true;
	}

	clear(): void {
		this.leases.clear();
	}
}

export class SessionGrantStore {
	private readonly grants = new Map<string, Grant>();

	list(): Grant[] {
		return [...this.grants.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	count(): number {
		return this.grants.size;
	}

	clear(): void {
		this.grants.clear();
	}

	revoke(id: string): boolean {
		return this.grants.delete(id);
	}

	add(request: AuthorizationRequest, scope: "exact" | "subtree"): Grant {
		const grant = grantFromRequest(request, scope);
		this.grants.set(grant.id, grant);
		return grant;
	}

	find(request: AuthorizationRequest): Grant[] {
		return coveringGrants(this.list(), request);
	}
}

export class PersistentGrantStore {
	private grants: Grant[] = [];

	constructor(private readonly filePath: string) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
			this.grants = Array.isArray(parsed) ? parsed.filter(isGrant) : [];
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				this.grants = [];
				return;
			}
			throw error;
		}
	}

	list(): Grant[] {
		return [...this.grants];
	}

	count(): number {
		return this.grants.length;
	}

	async add(request: AuthorizationRequest): Promise<Grant | undefined> {
		const grant = persistentGrantFromRequest(request);
		if (grant === undefined) return undefined;
		this.grants.push(grant);
		await this.save();
		return grant;
	}

	async revoke(id: string): Promise<boolean> {
		const before = this.grants.length;
		this.grants = this.grants.filter((grant) => grant.id !== id);
		if (this.grants.length !== before) await this.save();
		return this.grants.length !== before;
	}

	async revokeAll(): Promise<void> {
		this.grants = [];
		await this.save();
	}

	find(request: AuthorizationRequest): Grant[] {
		return coveringGrants(this.grants, request);
	}

	private async save(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, `${JSON.stringify(this.grants, null, "\t")}\n`, "utf8");
		await rename(temp, this.filePath);
	}
}

export function resourceFingerprint(resource: PermissionResource): string {
	if (resource.kind === "file") {
		const identity = resource.identity ?? resource.canonicalParentIdentity;
		return [
			"file",
			resource.operation,
			resource.access,
			resource.canonicalPath,
			resource.exists,
			identity?.device ?? "",
			identity?.inode ?? "",
		].join("|");
	}
	return JSON.stringify(resource);
}

export function canCreatePersistentGrant(request: AuthorizationRequest): boolean {
	return persistentScopes(request).length > 0;
}

export function resourcesUnchanged(previous: PermissionResource[], current: PermissionResource[]): boolean {
	if (!sameSet(previous.map(resourceFingerprint), current.map(resourceFingerprint))) return false;
	for (const oldResource of previous) {
		if (oldResource.kind !== "file") continue;
		const currentResource = current.find((item): item is ResolvedFileResource => item.kind === "file" && item.canonicalPath === oldResource.canonicalPath);
		if (currentResource === undefined) return false;
		if (oldResource.exists !== currentResource.exists) return false;
		if (!identityEquals(oldResource.identity ?? oldResource.canonicalParentIdentity, currentResource.identity ?? currentResource.canonicalParentIdentity)) return false;
	}
	return true;
}

function grantFromRequest(request: AuthorizationRequest, scope: "exact" | "subtree"): Grant {
	const files = request.resources.filter((resource): resource is ResolvedFileResource => resource.kind === "file");
	const scopes = scope === "exact" ? exactScopes(request) : fileSubtreeScopes(files);
	return {
		id: `grant_${randomUUID()}`,
		subjectId: request.subject.id,
		...(request.subject.source.identity !== undefined ? { subjectIdentity: request.subject.source.identity } : {}),
		scopes: scopes.length > 0 ? scopes : exactScopes(request),
		createdAt: Date.now(),
		status: "active",
	};
}

function persistentGrantFromRequest(request: AuthorizationRequest): Grant | undefined {
	const scopes = persistentScopes(request);
	if (scopes.length === 0) return undefined;
	return {
		id: `grant_${randomUUID()}`,
		subjectId: request.subject.id,
		...(request.subject.source.identity !== undefined ? { subjectIdentity: request.subject.source.identity } : {}),
		scopes,
		createdAt: Date.now(),
		status: "active",
	};
}

function coveringGrants(grants: Grant[], request: AuthorizationRequest): Grant[] {
	const active = grants.filter(
		(grant) =>
			grant.status === "active" &&
			grant.subjectId === request.subject.id &&
			grant.subjectIdentity === request.subject.source.identity,
	);
	const structured = active.filter((grant) => requestCoveredByScopes(request, grant.scopes));
	return structured.length > 0 ? structured : [];
}

function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item) => right.includes(item));
}

function isGrant(value: unknown): value is Grant {
	return typeof value === "object" && value !== null && "id" in value && "subjectId" in value && "status" in value && "scopes" in value && Array.isArray(value.scopes);
}

function exactScopes(request: AuthorizationRequest): GrantScope[] {
	return request.resources.flatMap((resource) => exactScope(request.subject, resource));
}

function exactScope(subject: PermissionSubject, resource: PermissionResource): GrantScope[] {
	if (resource.kind === "file") return [{ kind: "file-exact", path: resource.canonicalPath, operation: resource.operation, access: resource.access }];
	if (resource.kind === "command") return [{ kind: "command-exact", commandFingerprint: commandFingerprint(resource.command) }];
	if (resource.kind === "mcp") return [{ kind: "mcp-tool", server: resource.server, tool: resource.tool }];
	if (resource.kind === "skill" || resource.kind === "agent") return [{ kind: "subject", subjectId: subject.id }];
	return [];
}

function fileSubtreeScopes(files: ResolvedFileResource[]): GrantScope[] {
	return files.map((file) => ({
		kind: "file-subtree",
		path: subtreePath(file),
		operations: [file.operation],
		access: file.access,
	}));
}

function persistentScopes(request: AuthorizationRequest): GrantScope[] {
	const scopes = request.resources.flatMap((resource): GrantScope[] => {
		if (resource.kind === "file") {
			return [{ kind: "file-subtree", path: subtreePath(resource), operations: [resource.operation], access: resource.access }];
		}
		return exactScope(request.subject, resource);
	});
	return scopes.length === request.resources.length ? scopes : [];
}

function subtreePath(file: ResolvedFileResource): string {
	return file.targetType === "directory" ? file.canonicalPath : path.dirname(file.canonicalPath);
}

function requestCoveredByScopes(request: AuthorizationRequest, scopes: GrantScope[]): boolean {
	if (request.resources.length === 0) return scopes.some((scope) => scope.kind === "subject" && scope.subjectId === request.subject.id);
	return request.resources.every((resource) => scopes.some((scope) => resourceCoveredByScope(request.subject, resource, scope)));
}

function resourceCoveredByScope(subject: PermissionSubject, resource: PermissionResource, scope: GrantScope): boolean {
	if (scope.kind === "subject") return scope.subjectId === subject.id;
	if (resource.kind === "file") {
		if (scope.kind === "file-exact") return scope.path === resource.canonicalPath && scope.operation === resource.operation && scope.access === resource.access;
		return scope.kind === "file-subtree" && scope.access === resource.access && scope.operations.includes(resource.operation) && isPathInside(scope.path, resource.canonicalPath);
	}
	if (resource.kind === "command") return scope.kind === "command-exact" && scope.commandFingerprint === commandFingerprint(resource.command);
	if (resource.kind === "mcp") return scope.kind === "mcp-tool" && scope.server === resource.server && scope.tool === resource.tool;
	if (resource.kind === "skill" || resource.kind === "agent") return false;
	return false;
}

function commandFingerprint(command: string): string {
	return createHash("sha256").update(command).digest("hex");
}
