import { parsePermissionCommand } from "../command-parser.js";
import { routePermissionCommand } from "../command-router.js";
import type { PermissionCommandContext, PermissionCommandResult } from "../permission-command.js";
import { statusView } from "../application-service.js";

const MENU = ["Overview", "Tools", "File roots", "Grants", "Audit", "Diagnostics", "Edit policy", "Profile", "Maintenance", "Close"] as const;

/** 默认 /permissions 控制台；用 select/editor 的循环状态机实现，避免递归页面。 */
export async function openPermissionsConsole(context: PermissionCommandContext): Promise<PermissionCommandResult> {
	if (!context.ctx.hasUI) {
		const status = await routePermissionCommand(parsePermissionCommand("status"), { ...context, interactive: false });
		return { ...status, command: "console" };
	}
	let screen: (typeof MENU)[number] = "Overview";
	for (;;) {
		if (context.signal?.aborted) return { command: "console", data: { closed: true, reason: "aborted" }, human: "Permissions console closed." };
		if (screen === "Close") return { command: "console", data: { closed: true }, human: "Permissions console closed." };
		await showScreen(context, screen);
		const next = await context.ctx.ui.select("Permissions", [...MENU], signalOptions(context));
		if (next === undefined || next === "Close") return { command: "console", data: { closed: true }, human: "Permissions console closed." };
		screen = next as (typeof MENU)[number];
	}
}

async function showScreen(context: PermissionCommandContext, screen: (typeof MENU)[number]): Promise<void> {
	if (screen === "Overview") {
		const status = await statusView(context.runtime);
		context.ctx.ui.notify(
			[
				"Permissions",
				"",
				`Profile                 ${status.profile.effective}`,
				`Global policy           ${status.policies.global.status}`,
				`Project policy          ${status.policies.project.status}${status.policies.projectTrusted ? " · trusted" : ""}`,
				`Policy generation       ${status.generations.policy}`,
				"",
				`Authorized roots        ${status.roots.readOnly + status.roots.readWrite}`,
				`Session grants          ${status.grants.session}`,
				`Persistent grants       ${status.grants.persistent}`,
				`Suspended grants        ${status.grants.suspended}`,
				`Maintenance mode        ${status.maintenance.enabled ? "on" : "off"}`,
				`Audit                   ${status.audit.enabled ? "enabled" : "disabled"}`,
			].join("\n"),
			status.policies.global.status === "valid" && status.policies.project.status !== "invalid" ? "info" : "error",
		);
		return;
	}
	const command = commandForScreen(screen);
	if (command !== undefined) {
		const result = await routePermissionCommand(parsePermissionCommand(command), { ...context, interactive: true });
		context.ctx.ui.notify(result.human.slice(0, 3000), "info");
		return;
	}
	if (screen === "Edit policy") {
		const choice = await context.ctx.ui.select("Edit policy", ["Global", "Project", "Back"], signalOptions(context));
		if (choice === "Global") await routePermissionCommand(parsePermissionCommand("policy edit global"), context).then((result) => context.ctx.ui.notify(result.human, "info"));
		if (choice === "Project") await routePermissionCommand(parsePermissionCommand("policy edit project"), context).then((result) => context.ctx.ui.notify(result.human, "info"));
		return;
	}
}

function commandForScreen(screen: (typeof MENU)[number]): string | undefined {
	if (screen === "Tools") return "catalog tools";
	if (screen === "File roots") return "roots";
	if (screen === "Grants") return "grants";
	if (screen === "Audit") return "audit";
	if (screen === "Diagnostics") return "policy doctor";
	if (screen === "Profile") return "profile";
	if (screen === "Maintenance") return "maintenance";
	return undefined;
}

function signalOptions(context: PermissionCommandContext): { signal?: AbortSignal } | undefined {
	return context.signal === undefined ? undefined : { signal: context.signal };
}
