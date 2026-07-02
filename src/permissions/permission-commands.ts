import type { PermissionAction, PermissionPromptContext, PermissionToolName } from "./permission-types.js";
import { isPermissionTool } from "./policy-schema.js";
import type { PermissionService } from "./permission-service.js";
import { accessForPath } from "./access-extractors.js";

export interface PermissionCommandApi {
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler(args: string, ctx: PermissionCommandContext): Promise<void> | void;
		},
	): void;
}

export interface PermissionCommandContext {
	cwd: string;
	isProjectTrusted(): boolean;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<boolean>;
		select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		setStatus(key: string, text: string | undefined): void;
	};
}

/** 注册 /permissions 命令；命令只管理权限状态，不通过普通 edit 写策略。 */
export function registerPermissionCommands(
	api: PermissionCommandApi,
	getService: (ctx: PermissionCommandContext) => Promise<PermissionService>,
): void {
	api.registerCommand("permissions", {
		description: "Manage file permissions",
		handler: async (args, ctx) => {
			const service = await getService(ctx);
			const argv = splitArgs(args);
			const command = argv[0] ?? "status";
			if (command === "status" || command === "") {
				const status = await service.status();
				report(ctx, [
					`mode: ${status.mode}`,
					`global: ${status.globalPolicy.status} ${status.globalPolicy.path}`,
					`project: ${status.projectPolicy.status} ${status.projectPolicy.path}`,
					`projectTrusted: ${status.projectTrusted}`,
					`generation: ${status.policyGeneration}`,
					`sessionGrants: ${status.sessionGrantCount}`,
					`audit: ${status.auditEnabled ? "enabled" : "disabled"}`,
					...status.recentErrors.map((error) => `error: ${error}`),
				]);
				return;
			}
			if (command === "grants") {
				const grants = service.getGrants().list();
				report(
					ctx,
					grants.length === 0
						? ["No session grants."]
						: grants.map(
								(grant) =>
									`${grant.id} ${grant.actions.join(",")} ${grant.resource.scope} ${grant.resource.canonicalPath} ${new Date(grant.createdAt).toISOString()}`,
							),
				);
				return;
			}
			if (command === "revoke" && argv[1] !== undefined) {
				report(ctx, [service.getGrants().revoke(argv[1]) ? `Revoked ${argv[1]}.` : `Grant not found: ${argv[1]}.`]);
				return;
			}
			if (command === "revoke-all") {
				service.getGrants().clear();
				report(ctx, ["All session grants revoked."]);
				return;
			}
			if (command === "mode" && (argv[1] === "safe" || argv[1] === "read-only" || argv[1] === "yolo")) {
				service.setMode(argv[1]);
				ctx.ui.setStatus("permissions", `PERM: ${argv[1].toUpperCase()}`);
				report(ctx, [`Permission mode: ${argv[1]}.`]);
				return;
			}
			if (command === "reload" || command === "validate") {
				const status = await service.status();
				const errors = [status.globalPolicy, status.projectPolicy]
					.filter((policy) => policy.status === "invalid" || policy.status === "load_failed")
					.map((policy) => `${policy.path}: ${policy.error ?? policy.status}`);
				report(ctx, errors.length === 0 ? [`${command}: ok`] : errors);
				return;
			}
			if (command === "explain") {
				const tool = argv[1];
				const targetPath = argv[2];
				if (!isPermissionTool(tool) || targetPath === undefined) {
					report(ctx, ["Usage: /permissions explain <ls|read|edit> <path>"]);
					return;
				}
				await explain(ctx, service, tool, targetPath);
				return;
			}
			if (command === "edit" && (argv[1] === "global" || argv[1] === "project")) {
				const status = await service.status();
				const filePath = argv[1] === "global" ? status.globalPolicy.path : status.projectPolicy.path;
				const text = `Edit this policy file outside the agent edit tool:\n${filePath}\n\n普通 edit 不能修改权限策略；请使用可信编辑器保存后执行 /permissions reload。`;
				await ctx.ui.editor(`permissions ${argv[1]}`, text);
				return;
			}
			report(ctx, [
				"Commands: status, explain, grants, revoke, revoke-all, reload, validate, edit global|project, mode safe|read-only|yolo",
			]);
		},
	});
}

export function promptContextFromUi(ctx: PermissionCommandContext, timeoutMs: number): PermissionPromptContext {
	return {
		hasUI: ctx.hasUI,
		timeoutMs,
		prompt: async (request, evaluation) => {
			const lines = request.accesses.map((access) => `${access.action} ${access.displayPath}\n=> ${access.canonicalPath}`);
			const choice = await ctx.ui.select(
				`Permission ${evaluation.effect}: ${request.toolName}`,
				[
					"Allow once",
					"Allow exact path for session",
					"Allow directory for session",
					"Deny",
				].concat(lines),
				{ timeout: timeoutMs },
			);
			if (choice === "Allow once") return { decision: "allow-once" };
			if (choice === "Allow exact path for session") return { decision: "allow-session-exact" };
			if (choice === "Allow directory for session") return { decision: "allow-session-subtree" };
			return { decision: "deny" };
		},
	};
}

async function explain(
	ctx: PermissionCommandContext,
	service: PermissionService,
	tool: PermissionToolName,
	targetPath: string,
): Promise<void> {
	const access = await accessForPath(service.resourceResolver, representativeAction(tool), targetPath);
	const evaluation = await service.explain(access, tool);
	report(ctx, [
		`effect: ${evaluation.effect}`,
		`tool: ${tool}`,
		`boundary: ${access.boundary}`,
		`canonical: ${access.canonicalPath}`,
		`matched: ${evaluation.matchedRule?.id ?? "none"}`,
		`reason: ${evaluation.reason}`,
		`sessionGrantCanSatisfyAsk: ${evaluation.effect === "ask" ? "yes" : "no"}`,
	]);
}

function representativeAction(tool: PermissionToolName): PermissionAction {
	if (tool === "ls") return "fs.list";
	if (tool === "read") return "fs.read";
	return "fs.update";
}

function report(ctx: PermissionCommandContext, lines: string[]): void {
	const message = lines.join("\n");
	ctx.ui.notify(message.length > 1800 ? `${message.slice(0, 1800)}...` : message, "info");
}

function splitArgs(input: string): string[] {
	const matches = input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
	return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}
