import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { PermissionAuditEntry, PermissionResource, SanitizedAuditResource } from "./permission-types.js";

/** 串行 JSONL 审计日志；失败只记录最近错误，不改变既定授权结果。 */
export class AuditLogger {
	private lastError: string | undefined;
	private writeQueue = Promise.resolve();

	constructor(
		private readonly options: {
			path: string;
			enabled: boolean;
		},
	) {}

	isEnabled(): boolean {
		return this.options.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.options.enabled = enabled;
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	record(entry: PermissionAuditEntry): Promise<void> {
		if (!this.options.enabled) return Promise.resolve();
		this.writeQueue = this.writeQueue.then(async () => {
			try {
				await mkdir(path.dirname(this.options.path), { recursive: true });
				await appendFile(this.options.path, `${JSON.stringify(entry)}\n`, "utf8");
			} catch (error) {
				this.lastError = error instanceof Error ? error.message : String(error);
			}
		});
		return this.writeQueue;
	}

	async tail(limit: number): Promise<string[]> {
		try {
			const lines = (await readFile(this.options.path, "utf8")).trim().split(/\r?\n/).filter(Boolean);
			return lines.slice(-limit);
		} catch {
			return [];
		}
	}

	async tailEntries(limit: number): Promise<PermissionAuditEntry[]> {
		const entries: PermissionAuditEntry[] = [];
		for (const line of await this.tail(limit)) {
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isAuditEntry(parsed)) entries.push(parsed);
			} catch {
				entries.push(corruptAuditEntry(line));
			}
		}
		return entries;
	}

	async findEntry(id: string): Promise<PermissionAuditEntry | undefined> {
		for (const entry of await this.tailEntries(1000)) {
			if (entry.requestId === id || entry.leaseId === id || entry.grantIds?.includes(id)) return entry;
		}
		return undefined;
	}
}

export function sanitizeResource(resource: PermissionResource): SanitizedAuditResource {
	if (resource.kind === "file") {
		return {
			kind: "file",
			access: resource.access,
			operation: resource.operation,
			path: resource.displayPath,
			exists: resource.exists,
			viaSymlink: resource.viaSymlink,
		};
	}
	if (resource.kind === "command") return { kind: "command", commandPattern: resource.command.slice(0, 200) };
	if (resource.kind === "mcp") return { kind: "mcp", server: resource.server, tool: resource.tool };
	if (resource.kind === "skill") return { kind: "skill", name: resource.name };
	if (resource.kind === "agent") return { kind: "agent", name: resource.name };
	return { kind: "opaque", label: resource.label };
}

function isAuditEntry(value: unknown): value is PermissionAuditEntry {
	return typeof value === "object" && value !== null && "timestamp" in value && "requestId" in value && "subject" in value;
}

function corruptAuditEntry(line: string): PermissionAuditEntry {
	return {
		timestamp: new Date(0).toISOString(),
		requestId: `corrupt:${line.slice(0, 24)}`,
		subject: { id: "unknown", configKey: "unknown", kind: "unknown", source: "audit-log" },
		inputFingerprint: "",
		policyGeneration: 0,
		registryGeneration: 0,
		operations: [],
		resources: [{ kind: "opaque", label: "Corrupt audit record omitted." }],
		policyEffect: "policy-error",
		finalDecision: "denied",
		decisionSource: "runtime-error",
		errorCode: "PERMISSION_AUDIT_RECORD_INVALID",
	};
}
