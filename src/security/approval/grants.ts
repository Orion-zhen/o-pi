import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digest } from "../model/digest.js";
import type { AuthorizationRequest } from "../model/types.js";

export interface ApprovalGrant {
	id: string;
	principalPattern: string;
	componentPattern: string;
	actionPatterns: readonly string[];
	resourcePatterns: readonly string[];
	sessionId?: string;
	agentInstanceId?: string;
	componentIdentityDigest: string;
	schemaDigest?: string;
	policyDigestAtIssue: string;
	expiresAt?: number;
	remainingUses?: number;
	status: "active" | "suspended";
	suspendedReason?: "identity_changed" | "schema_changed" | "component_missing";
}

export class GrantStore {
	private readonly sessionGrants = new Map<string, ApprovalGrant>();
	private persistent: ApprovalGrant[] = [];

	constructor(private readonly filePath: string) {}

	sessionList(): ApprovalGrant[] {
		return [...this.sessionGrants.values()];
	}

	persistentList(): ApprovalGrant[] {
		return [...this.persistent];
	}

	clearSession(): void {
		this.sessionGrants.clear();
	}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
			this.persistent = Array.isArray(parsed) ? parsed.filter(isGrant) : [];
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				this.persistent = [];
				return;
			}
			throw error;
		}
	}

	find(request: AuthorizationRequest): ApprovalGrant[] {
		const now = Date.now();
		return [...this.sessionGrants.values(), ...this.persistent].filter((grant) => grantMatches(grant, request, now));
	}

	addSession(request: AuthorizationRequest, scope: "exact" | "subtree"): ApprovalGrant {
		const grant = grantFromRequest(request, scope, "session");
		this.sessionGrants.set(grant.id, grant);
		return grant;
	}

	async addPersistent(request: AuthorizationRequest): Promise<ApprovalGrant> {
		const grant = grantFromRequest(request, "subtree", "persistent");
		this.persistent.push(grant);
		await this.save();
		return grant;
	}

	async suspendStale(activeComponentDigests: ReadonlySet<string>): Promise<void> {
		let changed = false;
		this.persistent = this.persistent.map((grant) => {
			if (grant.status !== "active") return grant;
			if (!activeComponentDigests.has(grant.componentIdentityDigest)) {
				changed = true;
				return { ...grant, status: "suspended", suspendedReason: "component_missing" as const };
			}
			return grant;
		});
		if (changed) await this.save();
	}

	private async save(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, `${JSON.stringify(this.persistent, null, "\t")}\n`, "utf8");
		await rename(temp, this.filePath);
	}
}

function grantFromRequest(request: AuthorizationRequest, scope: "exact" | "subtree", lifetime: "session" | "persistent"): ApprovalGrant {
	const resources = scope === "subtree" ? request.atoms.map((atom) => subtreePattern(atom.resource)) : request.atoms.map((atom) => atom.resource);
	return {
		id: `grant_${digest({ request: request.requestId, lifetime, at: Date.now() }).slice(7, 23)}`,
		principalPattern: request.principal.agentDefinitionId,
		componentPattern: request.component.displayName,
		actionPatterns: [...new Set(request.atoms.map((atom) => atom.action))],
		resourcePatterns: [...new Set(resources)],
		...(lifetime === "session" ? { sessionId: request.principal.sessionId } : {}),
		agentInstanceId: request.principal.agentInstanceId,
		componentIdentityDigest: digest(request.component),
		...(request.component.schemaDigest !== undefined ? { schemaDigest: request.component.schemaDigest } : {}),
		policyDigestAtIssue: request.context.policyDigest,
		status: "active",
	};
}

function grantMatches(grant: ApprovalGrant, request: AuthorizationRequest, now: number): boolean {
	if (grant.status !== "active") return false;
	if (grant.expiresAt !== undefined && grant.expiresAt < now) return false;
	if (grant.sessionId !== undefined && grant.sessionId !== request.principal.sessionId) return false;
	if (grant.agentInstanceId !== undefined && grant.agentInstanceId !== request.principal.agentInstanceId) return false;
	if (grant.principalPattern !== "*" && grant.principalPattern !== request.principal.agentDefinitionId) return false;
	if (grant.componentPattern !== "*" && grant.componentPattern !== request.component.displayName) return false;
	if (grant.componentIdentityDigest !== digest(request.component)) return false;
	if (grant.schemaDigest !== undefined && grant.schemaDigest !== request.component.schemaDigest) return false;
	if (grant.policyDigestAtIssue !== request.context.policyDigest) return false;
	return request.atoms.every(
		(atom) => matchesAny(grant.actionPatterns, atom.action) && matchesAny(grant.resourcePatterns, atom.resource),
	);
}

function subtreePattern(resource: string): string {
	if (!resource.startsWith("file://")) return resource;
	const index = resource.lastIndexOf("/");
	return index < "file://".length ? resource : `${resource.slice(0, index)}/**`;
}

function matchesAny(patterns: readonly string[], value: string): boolean {
	return patterns.some((pattern) => pattern === "*" || pattern === value || (pattern.endsWith("/**") && value.startsWith(pattern.slice(0, -3))));
}

function isGrant(value: unknown): value is ApprovalGrant {
	return typeof value === "object" && value !== null && "id" in value && "status" in value && "actionPatterns" in value && "resourcePatterns" in value;
}
