import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { PermissionAuditEntry } from "./permission-types.js";

export interface AuditLoggerOptions {
	enabled: boolean;
	path?: string;
}

/** JSONL 安全审计日志；不记录文件内容、diff 或环境变量。 */
export class AuditLogger {
	private lastError: string | undefined;

	constructor(private readonly options: AuditLoggerOptions) {}

	isEnabled(): boolean {
		return this.options.enabled && this.options.path !== undefined;
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	async record(entry: PermissionAuditEntry): Promise<void> {
		if (!this.isEnabled()) return;
		const target = this.options.path;
		if (target === undefined) return;
		try {
			await mkdir(path.dirname(target), { recursive: true });
			await appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		}
	}
}
