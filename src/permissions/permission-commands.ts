import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { PermissionPromptContext } from "./permission-types.js";
import type { PermissionService } from "./permission-service.js";
import { canCreatePersistentGrant } from "./grants.js";
import { renderPermissionApprovalPrompt } from "./approval-prompt.js";
import { parsePermissionCommand } from "./commands/command-parser.js";
import { routePermissionCommand } from "./commands/command-router.js";
import { HumanPermissionRenderer, JsonPermissionRenderer } from "./commands/output-renderer.js";
import { PermissionCommandError, type PermissionCommandContext as RouterCommandContext, hasFlag } from "./commands/permission-command.js";

export type PermissionCommandContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui" | "signal" | "sessionManager" | "isProjectTrusted">;

/** 注册 /permissions 控制台；命令解析、分发和输出都在 commands/ 下完成。 */
export function registerPermissionCommands(api: ExtensionAPI, getService: (ctx: PermissionCommandContext) => Promise<PermissionService>): void {
	api.registerCommand("permissions", {
		description: "Manage permissions",
		handler: async (args, ctx) => {
			let parsed: ReturnType<typeof parsePermissionCommand> | undefined;
			const jsonRenderer = new JsonPermissionRenderer();
			try {
				parsed = parsePermissionCommand(args);
				const service = await getService(ctx);
				const serviceOptions = service.getOptions();
				const outputMode = hasFlag(parsed, "json") ? "json" : "human";
				const commandContext: RouterCommandContext = {
					runtime: service,
					ctx,
					interactive: parsed.path.length === 0,
					outputMode,
					workspacePath: serviceOptions.workspaceRoot,
					agentDir: serviceOptions.agentDir,
					...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
				};
				const result = await routePermissionCommand(parsed, commandContext);
				const text = outputMode === "json" ? jsonRenderer.render(result) : new HumanPermissionRenderer().render(result);
				ctx.ui.notify(text.slice(0, outputMode === "json" ? 12000 : 5000), "info");
				await updateStatus(service, ctx);
			} catch (error) {
				const commandError = normalizeError(error);
				const json = parsed !== undefined && hasFlag(parsed, "json");
				const text = json
					? jsonRenderer.renderError(parsed, commandError)
					: humanError(commandError);
				ctx.ui.notify(text.slice(0, json ? 12000 : 5000), "error");
			}
		},
	});
}

export function promptContextFromUi(ctx: PermissionCommandContext, timeoutMs: number): PermissionPromptContext {
	return {
		hasUI: ctx.hasUI,
		timeoutMs,
		...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
		prompt: async (request, decision) => {
			const options = ctx.signal === undefined ? { timeout: timeoutMs } : { timeout: timeoutMs, signal: ctx.signal };
			const choices = [
				"Allow once",
				"Allow exact for session",
				...(request.resources.some((resource) => resource.kind === "file") ? ["Allow subtree for session"] : []),
				...(canCreatePersistentGrant(request) ? ["Always allow"] : []),
				"Deny",
			];
			const choice = await ctx.ui.select(
				renderPermissionApprovalPrompt(request, decision),
				choices,
				options,
			);
			if (choice === "Allow once") return { decision: "allow-once" };
			if (choice === "Allow exact for session") return { decision: "allow-session-exact" };
			if (choice === "Allow subtree for session") return { decision: "allow-session-subtree" };
			if (choice === "Always allow") return { decision: "always-allow" };
			return { decision: "deny" };
		},
	};
}

function normalizeError(error: unknown): { code: string; message: string; suggestions?: string[] } {
	if (error instanceof PermissionCommandError) {
		return error.suggestions.length === 0
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, suggestions: error.suggestions };
	}
	return { code: "PERMISSION_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

function humanError(error: { code: string; message: string; suggestions?: string[] }): string {
	return [
		error.message,
		error.suggestions === undefined || error.suggestions.length === 0 ? undefined : "",
		error.suggestions === undefined || error.suggestions.length === 0 ? undefined : "Did you mean:",
		...(error.suggestions?.map((item) => `  ${item}`) ?? []),
	].filter((line): line is string => line !== undefined).join("\n");
}

async function updateStatus(service: PermissionService, ctx: PermissionCommandContext): Promise<void> {
	const status = await service.getStatus();
	const label = status.globalPolicy.status === "invalid" || status.projectPolicy.status === "invalid"
		? "invalid"
		: status.maintenance
			? "maintenance"
			: status.profile;
	ctx.ui.setStatus("permissions", `permissions: ${label}`);
}
