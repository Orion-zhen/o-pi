import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { LspManager } from "./manager.js";

type LspCommandApi = Pick<ExtensionAPI, "registerCommand">;

/** 注册用户调试命令；不注册任何模型可见 lsp tool。 */
export function registerLspCommands(pi: LspCommandApi, manager: LspManager): void {
	pi.registerCommand("lsp", {
		description: "Show or reload internal LSP status",
		async handler(args, ctx) {
			await handleLspCommand(manager, args, ctx);
		},
	});
}

async function handleLspCommand(manager: LspManager, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	if (command === undefined || command === "status") {
		ctx.ui.notify(formatStatus(await manager.status()), "info");
		return;
	}
	if (command === "reload") {
		await manager.reload();
		ctx.ui.notify("LSP reloaded", "info");
		return;
	}
	if (command === "diagnostics") {
		const target = rest.join(" ").trim();
		const diagnostics = await manager.knownDiagnostics(ctx.cwd, target.length > 0 ? normalizeTarget(ctx.cwd, target) : undefined);
		ctx.ui.notify(formatDiagnostics(diagnostics), diagnostics.some((entry) => entry.items.some((item) => item.severity === "error")) ? "error" : "info");
		return;
	}
	ctx.ui.notify("usage: /lsp | /lsp status | /lsp reload | /lsp diagnostics [path]", "warning");
}

function formatStatus(status: Awaited<ReturnType<LspManager["status"]>>): string {
	const lines = [
		`LSP ${status.enabled ? "enabled" : "disabled"}`,
		`config: ${status.config_path}`,
	];
	if (status.last_error !== undefined) lines.push(`last error: ${status.last_error}`);
	if (status.servers.length === 0) {
		lines.push("servers: none started");
		return lines.join("\n");
	}
	lines.push("servers:");
	for (const server of status.servers) {
		lines.push(`  ${server.id} · ${server.status} · root ${server.root} · docs ${server.open_documents} · diagnostics ${server.diagnostics} · restarts ${server.restarts}`);
		if (server.last_error !== undefined) lines.push(`    last error: ${server.last_error}`);
	}
	return lines.join("\n");
}

function formatDiagnostics(entries: Array<{ path: string; items: Array<{ severity: string; line: number; column: number; message: string; code?: string; source?: string }> }>): string {
	if (entries.length === 0) return "LSP diagnostics: none known";
	const lines = ["LSP diagnostics:"];
	for (const entry of entries) {
		lines.push(`${entry.path}: ${entry.items.length}`);
		for (const item of entry.items) {
			const suffix = [item.code, item.source].filter((value): value is string => value !== undefined).join(" ");
			lines.push(`  ${item.severity} ${item.line}:${item.column} ${item.message}${suffix.length > 0 ? ` (${suffix})` : ""}`);
		}
	}
	return lines.join("\n");
}

function normalizeTarget(cwd: string, target: string): string {
	const absolute = path.resolve(cwd, target);
	const relative = path.relative(cwd, absolute);
	return relative === "" ? "." : relative.replace(/\\/g, "/");
}
