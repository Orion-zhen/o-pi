import { randomUUID } from "node:crypto";

import type { PermissionAccess, PermissionAction, SessionGrant } from "./permission-types.js";
import { identityEquals, isPathInside } from "./path-utils.js";

/** 仅驻留内存的会话授权；进程结束即失效。 */
export class SessionGrantStore {
	private readonly grants = new Map<string, SessionGrant>();

	list(): SessionGrant[] {
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

	add(input: {
		actions: PermissionAction[];
		canonicalPath: string;
		scope: "exact" | "subtree";
		lifetime: "once" | "session";
		toolCallId: string;
		requestFingerprint: string;
		rootIdentity?: SessionGrant["rootIdentity"];
	}): SessionGrant {
		const grant: SessionGrant = {
			id: `grant_${randomUUID()}`,
			actions: input.actions,
			resource: { canonicalPath: input.canonicalPath, scope: input.scope },
			lifetime: input.lifetime,
			createdAt: Date.now(),
			origin: { toolCallId: input.toolCallId, requestFingerprint: input.requestFingerprint },
			...(input.rootIdentity !== undefined ? { rootIdentity: input.rootIdentity } : {}),
		};
		this.grants.set(grant.id, grant);
		return grant;
	}

	find(accesses: PermissionAccess[], toolCallId: string, fingerprint: string): SessionGrant | undefined {
		for (const grant of this.list()) {
			if (grant.lifetime === "once" && (grant.origin.toolCallId !== toolCallId || grant.origin.requestFingerprint !== fingerprint)) {
				continue;
			}
			if (accesses.every((access) => grantMatchesAccess(grant, access))) return grant;
		}
		return undefined;
	}

	consumeOnce(toolCallId: string, fingerprint: string): void {
		for (const grant of this.list()) {
			if (grant.lifetime === "once" && grant.origin.toolCallId === toolCallId && grant.origin.requestFingerprint === fingerprint) {
				this.grants.delete(grant.id);
			}
		}
	}
}

function grantMatchesAccess(grant: SessionGrant, access: PermissionAccess): boolean {
	if (!grant.actions.includes(access.action)) return false;
	if (grant.resource.scope === "exact" && grant.resource.canonicalPath !== access.canonicalPath) return false;
	if (grant.resource.scope === "subtree" && !isPathInside(grant.resource.canonicalPath, access.canonicalPath)) return false;
	if (grant.rootIdentity !== undefined && !identityEquals(grant.rootIdentity, access.identity ?? access.canonicalParentIdentity)) return false;
	return true;
}
