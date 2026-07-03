import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { digest } from "../model/digest.js";
import type { AuthorizationDecision, AuthorizationRequest } from "../model/types.js";

export interface AuditEntry {
	timestamp: number;
	principal: {
		userId: string;
		sessionId: string;
		agentDefinitionId: string;
		agentInstanceId: string;
		lineage: readonly string[];
	};
	component: {
		id: string;
		kind: string;
		displayName: string;
		sourceDigest: string;
		schemaDigest?: string;
		manifestDigest?: string;
	};
	atoms: readonly { action: string; resource: string }[];
	decision: string;
	matchedPolicyIds: readonly string[];
	policyDigest: string;
	requestDigest: string;
	redactedPreview: string;
	riskLabels: readonly string[];
}

export class AuditLogger {
	private enabled = true;
	private queue = Promise.resolve();

	constructor(private readonly filePath: string) {}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	record(request: AuthorizationRequest, decision: AuthorizationDecision, input: unknown): Promise<void> {
		if (!this.enabled) return Promise.resolve();
		const entry: AuditEntry = {
			timestamp: Date.now(),
			principal: {
				userId: request.principal.userId,
				sessionId: request.principal.sessionId,
				agentDefinitionId: request.principal.agentDefinitionId,
				agentInstanceId: request.principal.agentInstanceId,
				lineage: request.principal.lineage,
			},
			component: request.component,
			atoms: request.atoms.map((atom) => ({ action: atom.action, resource: atom.resource })),
			decision: decision.kind,
			matchedPolicyIds: decision.matchedPolicyIds,
			policyDigest: request.context.policyDigest,
			requestDigest: digest(request),
			redactedPreview: redact(input),
			riskLabels: decision.riskLabels,
		};
		this.queue = this.queue.then(async () => {
			await mkdir(path.dirname(this.filePath), { recursive: true });
			await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
		});
		return this.queue;
	}

	async tail(limit: number): Promise<AuditEntry[]> {
		try {
			const lines = (await readFile(this.filePath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
			return lines.slice(-limit).map((line) => JSON.parse(line) as AuditEntry);
		} catch {
			return [];
		}
	}
}

/** 集中脱敏，禁止记录 token、Authorization、password 和常见 secret 值。 */
export function redact(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text
		.replace(/"authorization"\s*:\s*"bearer\s+[^"]+"/gi, '"authorization":"[REDACTED]"')
		.replace(/authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]+/gi, "authorization: [REDACTED]")
		.replace(/"(token|password|secret|api[_-]?key)"\s*:\s*"[^"]+"/gi, '"$1":"[REDACTED]"')
		.replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[REDACTED]")
		.replace(/"[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*"\s*:\s*"[^"]+"/g, '"TOKEN":"[REDACTED]"')
		.replace(/[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=["']?[^"',\s}]+/g, "TOKEN=[REDACTED]")
		.slice(0, 300);
}
