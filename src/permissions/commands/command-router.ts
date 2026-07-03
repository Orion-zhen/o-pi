import {
	addGlobalRoot,
	assertEffect,
	assertProfile,
	assertRootAccess,
	auditShowView,
	auditTailView,
	catalogView,
	explainView,
	grantView,
	grantsView,
	policyDoctorView,
	policyShowView,
	policyValidateView,
	removeGlobalRoot,
	resolveSubject,
	rootsView,
	statusView,
	subjectKindForSet,
} from "./application-service.js";
import { suggestCommand } from "./command-parser.js";
import { type ParsedPermissionCommand, PermissionCommandError, type PermissionCommandContext, type PermissionCommandResult, hasFlag } from "./permission-command.js";

const ROOT_COMMANDS = ["help", "status", "catalog", "explain", "set", "reset", "roots", "grants", "profile", "policy", "audit", "maintenance"] as const;

/** 命令 router 只做参数校验、调用服务和渲染 DTO。 */
export async function routePermissionCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	if (parsed.path.length === 0) {
		const { openPermissionsConsole } = await import("./interactive/permissions-console.js");
		return await openPermissionsConsole(context);
	}
	if (parsed.path.includes("help") || hasFlag(parsed, "help") || hasFlag(parsed, "h")) return result("help", helpFor(parsed.path), renderHelp(helpFor(parsed.path)));
	const root = parsed.path[0] ?? "";
	if (!ROOT_COMMANDS.includes(root as (typeof ROOT_COMMANDS)[number])) {
		throw new PermissionCommandError("PERMISSION_COMMAND_UNKNOWN", `Unknown permissions command: ${root}`, suggestCommand(root, ROOT_COMMANDS));
	}
	if (root === "status") return await statusCommand(context);
	if (root === "catalog") return catalogCommand(parsed, context);
	if (root === "explain") return await explainCommand(parsed, context);
	if (root === "set") return await setCommand(parsed, context);
	if (root === "reset") return await resetCommand(parsed, context);
	if (root === "roots") return await rootsCommand(parsed, context);
	if (root === "grants") return await grantsCommand(parsed, context);
	if (root === "profile") return await profileCommand(parsed, context);
	if (root === "policy") return await policyCommand(parsed, context);
	if (root === "audit") return await auditCommand(parsed, context);
	if (root === "maintenance") return await maintenanceCommand(parsed, context);
	return result("help", helpFor([]), renderHelp(helpFor([])));
}

async function statusCommand(context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const view = await statusView(context.runtime);
	return result("status", view, renderStatus(view));
}

function catalogCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): PermissionCommandResult {
	const filter = parsed.path[1] ?? parsed.positionals[0];
	const view = catalogView(context.runtime, filter);
	return result("catalog", view, renderCatalog(view.entries, filter));
}

async function explainCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const view = await explainView(context.runtime, parsed.positionals[0], parsed.positionals.slice(1));
	return result("explain", view, renderExplain(view));
}

async function setCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const [subjectText, decision] = parsed.positionals;
	if (subjectText === undefined || decision === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions set <subject> <allow|ask|deny> --global");
	assertEffect(decision);
	await requireGlobalWrite(parsed, context, "Update global permission policy?");
	const subject = subjectKindForSet(context.runtime, subjectText);
	const before = await context.runtime.getPolicySnapshot();
	const update = await import("./config-transaction.js").then(({ PermissionConfigurationTransactionService }) =>
		new PermissionConfigurationTransactionService(context.runtime).updateGlobal({ type: "set-subject", ...subject, decision }),
	);
	const data = { subject, decision, update };
	return result("set", data, `Updated global policy\n\nSubject\n  ${subjectText}\n\nDecision\n  ${decision}\n\nFile\n  ${update.filePath}\n\nPolicy generation\n  ${before.generation} -> ${update.afterGeneration}`);
}

async function resetCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const [subjectText] = parsed.positionals;
	if (subjectText === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions reset <subject> --global");
	await requireGlobalWrite(parsed, context, "Remove explicit global permission rule?");
	const subject = subjectKindForSet(context.runtime, subjectText);
	const update = await import("./config-transaction.js").then(({ PermissionConfigurationTransactionService }) =>
		new PermissionConfigurationTransactionService(context.runtime).updateGlobal({ type: "reset-subject", ...subject }),
	);
	return result("reset", { subject, update }, `Reset global policy rule\n\nSubject\n  ${subjectText}\n\nFile\n  ${update.filePath}\n\nPolicy generation\n  ${update.beforeGeneration} -> ${update.afterGeneration}`);
}

async function rootsCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const sub = parsed.path[1];
	if (sub === undefined) {
		const view = await rootsView(context.runtime);
		return result("roots", view, renderRoots(view.roots));
	}
	if (sub === "add") {
		const [inputPath, access] = parsed.positionals;
		if (inputPath === undefined || access === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions roots add <path> <read-only|read-write> --session|--global");
		if (hasFlag(parsed, "session")) {
			assertRootAccess(access);
			const root = context.runtime.addSessionFileRoot(inputPath, access);
			return result("roots add", root, `Added session root\n\nRoot\n  ${root.canonicalPath}\nAccess\n  ${root.access}`);
		}
		await requireGlobalWrite(parsed, context, "Add global authorized root?");
		const update = await addGlobalRoot(context.runtime, inputPath, access);
		return result("roots add", update, `Added global root\n\nRoot\n  ${inputPath}\nAccess\n  ${access}\nFile\n  ${update.filePath}`);
	}
	if (sub === "remove") {
		const [rootId] = parsed.positionals;
		if (rootId === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions roots remove <root-id> --global");
		if (hasFlag(parsed, "session")) {
			if (!context.runtime.removeSessionFileRoot(rootId)) throw new PermissionCommandError("PERMISSION_ROOT_NOT_FOUND", `Root not found: ${rootId}`);
			return result("roots remove", { id: rootId }, `Removed session root\n  ${rootId}`);
		}
		await requireGlobalWrite(parsed, context, "Remove global authorized root?");
		const update = await removeGlobalRoot(context.runtime, rootId);
		return result("roots remove", update, `Removed global root\n\nRoot\n  ${rootId}\nFile\n  ${update.filePath}`);
	}
	throw new PermissionCommandError("PERMISSION_COMMAND_UNKNOWN", `Unknown permissions roots command: ${sub}`, ["add", "remove"]);
}

async function grantsCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const sub = parsed.path[1];
	if (sub === undefined) {
		const view = await grantsView(context.runtime);
		return result("grants", view, renderGrants(view));
	}
	if (sub === "show") {
		const id = required(parsed.positionals[0], "Usage: /permissions grants show <grant-id>");
		const view = await grantView(context.runtime, id);
		return result("grants show", view, renderLines(["Grant", `  id: ${view.grant.id}`, `  subject: ${view.grant.subjectId}`, `  status: ${view.grant.status}`, "  scopes:", ...view.grant.scopes.map((scope) => `    ${scope.kind}`)]));
	}
	if (sub === "revoke") {
		const id = required(parsed.positionals[0], "Usage: /permissions grants revoke <grant-id>");
		const ok = await context.runtime.revokeGrant(id);
		if (!ok) throw new PermissionCommandError("PERMISSION_GRANT_NOT_FOUND", `Grant not found: ${id}`);
		return result("grants revoke", { id, revoked: true }, `Revoked grant\n  ${id}`);
	}
	if (sub === "clear") {
		const scope = hasFlag(parsed, "session") ? "session" : hasFlag(parsed, "persistent") ? "persistent" : hasFlag(parsed, "suspended") ? "suspended" : hasFlag(parsed, "all") ? "all" : undefined;
		if (scope === undefined) {
			throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions grants clear --session|--persistent|--suspended|--all");
		}
		const clearScope = scope;
		if (!hasFlag(parsed, "yes") && context.ctx.hasUI && !(await context.ctx.ui.confirm("Clear grants?", `Clear ${clearScope} grants?`))) {
			throw new PermissionCommandError("PERMISSION_OPERATION_CANCELLED", "Operation cancelled.");
		}
		if (!context.ctx.hasUI && !hasFlag(parsed, "yes")) throw new PermissionCommandError("PERMISSION_COMMAND_UI_REQUIRED", "Use --yes in no-UI mode to clear grants.");
		const cleared = await context.runtime.clearGrants(clearScope);
		return result("grants clear", { scope: clearScope, ...cleared }, `Cleared ${cleared.removed} ${clearScope} grants.`);
	}
	throw new PermissionCommandError("PERMISSION_COMMAND_UNKNOWN", `Unknown permissions grants command: ${sub}`, ["show", "revoke", "clear"]);
}

async function profileCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const sub = parsed.path[1];
	if (sub === undefined) {
		const view = (await statusView(context.runtime)).profile;
		return result("profile", view, renderLines(["Profile", `  configured: ${view.configured}`, "  session override: none", `  effective: ${view.effective}`]));
	}
	if (sub === "set") {
		const profile = required(parsed.positionals[0], "Usage: /permissions profile set <profile> --session|--global");
		assertProfile(profile);
		if (hasFlag(parsed, "global")) {
			await requireGlobalWrite(parsed, context, profile === "unrestricted" ? "Set unrestricted global profile?" : "Set global profile?");
			const update = await import("./config-transaction.js").then(({ PermissionConfigurationTransactionService }) =>
				new PermissionConfigurationTransactionService(context.runtime).updateGlobal({ type: "set-profile", profile }),
			);
			return result("profile set", { profile, scope: "global", update }, `Global profile set to ${profile}.`);
		}
		if (!hasFlag(parsed, "session") && !context.ctx.hasUI) throw new PermissionCommandError("PERMISSION_COMMAND_UI_REQUIRED", "Use --session or --global in no-UI mode.");
		if (profile === "unrestricted" && context.ctx.hasUI && !(await context.ctx.ui.confirm("Unrestricted profile?", "This defaults unconfigured requests to allow for the current session."))) {
			throw new PermissionCommandError("PERMISSION_OPERATION_CANCELLED", "Operation cancelled.");
		}
		context.runtime.setSessionProfileOverride(profile);
		return result("profile set", { profile, scope: "session" }, `Session profile set to ${profile}.`);
	}
	if (sub === "reset") {
		context.runtime.clearSessionProfileOverride();
		return result("profile reset", { reset: true }, "Session profile override cleared.");
	}
	throw new PermissionCommandError("PERMISSION_COMMAND_UNKNOWN", `Unknown permissions profile command: ${sub}`, ["set", "reset"]);
}

async function policyCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const sub = parsed.path[1] ?? "validate";
	if (sub === "validate") {
		const scope = parsePolicyScope(parsed.positionals[0]);
		const view = await policyValidateView(context.runtime, scope);
		return result("policy validate", view, renderValidate(view));
	}
	if (sub === "doctor") {
		const view = await policyDoctorView(context.runtime);
		return result("policy doctor", view, renderDoctor(view.findings));
	}
	if (sub === "reload") {
		const snapshot = await context.runtime.reloadPolicy();
		return result("policy reload", { generation: snapshot.generation, valid: snapshot.valid, diagnostics: snapshot.diagnostics }, snapshot.valid ? `Policy reloaded.\n\nPolicy generation\n  ${snapshot.generation}` : `Policy reload failed.\n\n${renderDiagnostics(snapshot.diagnostics)}`);
	}
	if (sub === "show") {
		const scope = parsePolicyShowScope(parsed.positionals[0]);
		const view = await policyShowView(context.runtime, scope);
		return result("policy show", view, scope === "effective" ? renderEffective(view) : String("text" in view ? view.text : ""));
	}
	if (sub === "edit") return await editPolicyCommand(parsed, context);
	throw new PermissionCommandError("PERMISSION_COMMAND_UNKNOWN", `Unknown permissions policy command: ${sub}`, ["validate", "doctor", "reload", "edit", "show"]);
}

async function editPolicyCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	if (!context.ctx.hasUI) throw new PermissionCommandError("PERMISSION_COMMAND_UI_REQUIRED", "This operation requires an interactive UI.");
	const scope = parsed.positionals[0] === "project" ? "project" : "global";
	const snapshot = await context.runtime.getPolicySnapshot();
	const filePath = scope === "global" ? snapshot.global.path : snapshot.project.path;
	const current = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8")).catch(() => "{\n\t\"version\": 1\n}\n");
	const edited = await context.ctx.ui.editor(scope === "global" ? "permissions global policy" : "permissions project policy", current);
	if (edited === undefined) throw new PermissionCommandError("PERMISSION_OPERATION_CANCELLED", "Operation cancelled.");
	const update = await import("./config-transaction.js").then(({ PermissionConfigurationTransactionService }) =>
		new PermissionConfigurationTransactionService(context.runtime).replacePolicy(scope, edited),
	);
	return result("policy edit", { scope, filePath, generation: update.afterGeneration }, `Saved ${scope} policy.\n\nFile\n  ${filePath}\nPolicy generation\n  ${update.afterGeneration}`);
}

async function auditCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const sub = parsed.path[1];
	if (sub === "show") {
		const id = required(parsed.positionals[0], "Usage: /permissions audit show <entry-id>");
		const view = await auditShowView(context.runtime, id);
		return result("audit show", view, renderAuditEntries([view.entry]));
	}
	const count = Number(parsed.positionals[0] ?? (sub === "tail" ? parsed.positionals[0] : "20"));
	const view = await auditTailView(context.runtime, Number.isFinite(count) && count > 0 ? count : 20);
	return result("audit", view, renderAuditEntries(view.entries));
}

async function maintenanceCommand(parsed: ParsedPermissionCommand, context: PermissionCommandContext): Promise<PermissionCommandResult> {
	const sub = parsed.path[1];
	if (sub === undefined) {
		const status = await context.runtime.getMaintenanceStatus();
		return result("maintenance", status, `Maintenance mode: ${status.enabled ? "on" : "off"}`);
	}
	if (sub === "on") {
		if (!context.ctx.hasUI) throw new PermissionCommandError("PERMISSION_COMMAND_UI_REQUIRED", "Maintenance mode requires an interactive UI.");
		const ok = await context.ctx.ui.confirm("Enable maintenance mode?", "Maintenance temporarily allows registered file tools to modify the permission control plane.");
		if (!ok) throw new PermissionCommandError("PERMISSION_OPERATION_CANCELLED", "Operation cancelled.");
		context.runtime.enterMaintenanceMode();
		return result("maintenance on", { enabled: true }, "Maintenance mode enabled for this session.");
	}
	if (sub === "off") {
		context.runtime.exitMaintenanceMode();
		return result("maintenance off", { enabled: false }, "Maintenance mode disabled.");
	}
	throw new PermissionCommandError("PERMISSION_COMMAND_UNKNOWN", `Unknown permissions maintenance command: ${sub}`, ["on", "off"]);
}

async function requireGlobalWrite(parsed: ParsedPermissionCommand, context: PermissionCommandContext, prompt: string): Promise<void> {
	if (hasFlag(parsed, "global")) return;
	if (!context.ctx.hasUI) throw new PermissionCommandError("PERMISSION_COMMAND_UI_REQUIRED", `${prompt}\nUse --global in no-UI mode.`);
	if (!(await context.ctx.ui.confirm("Permissions", prompt))) throw new PermissionCommandError("PERMISSION_OPERATION_CANCELLED", "Operation cancelled.");
}

function result<T>(command: string, data: T, human: string): PermissionCommandResult<T> {
	return { command, data, human };
}

function required(value: string | undefined, message: string): string {
	if (value === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", message);
	return value;
}

function renderStatus(view: Awaited<ReturnType<typeof statusView>>): string {
	const warnings = [
		view.profile.effective === "unrestricted" ? "WARNING: unrestricted profile is active for this session." : undefined,
		view.policies.global.status !== "valid" ? "ERROR: global policy is invalid; controlled tool calls are denied." : undefined,
		view.policies.project.status === "invalid" ? "ERROR: project policy is invalid; controlled tool calls are denied." : undefined,
	].filter((item): item is string => item !== undefined);
	return renderLines([
		...warnings,
		warnings.length > 0 ? "" : undefined,
		"Profile",
		`  configured: ${view.profile.configured}`,
		"  session override: none",
		`  effective: ${view.profile.effective}`,
		"",
		"Global policy",
		`  path: ${view.policies.global.path}`,
		`  status: ${view.policies.global.status}`,
		"",
		"Project policy",
		`  path: ${view.policies.project.path}`,
		`  status: ${view.policies.project.status}`,
		`  trusted: ${view.policies.projectTrusted ? "yes" : "no"}`,
		"",
		"Generations",
		`  policy: ${view.generations.policy}`,
		`  registry: ${view.generations.registry}`,
		"",
		"Subjects",
		`  tools: ${view.subjectCounts.tools}`,
		"",
		"File roots",
		`  read-write: ${view.roots.readWrite}`,
		`  read-only: ${view.roots.readOnly}`,
		"",
		"Grants",
		`  session: ${view.grants.session}`,
		`  persistent: ${view.grants.persistent}`,
		`  suspended: ${view.grants.suspended}`,
		"",
		`Maintenance mode: ${view.maintenance.enabled ? "on" : "off"}`,
		`Audit: ${view.audit.enabled ? "enabled" : "disabled"}`,
	]);
}

function renderCatalog(entries: ReturnType<typeof catalogView>["entries"], filter: string | undefined): string {
	if (entries.length === 0) return filter === undefined ? "Catalog is empty." : `No catalog entries match ${filter}.`;
	return renderLines([
		filter === undefined ? "Catalog" : `Catalog: ${filter}`,
		"",
		...entries.flatMap((entry) => [
			entry.configKey,
			`  Display name: ${entry.displayName}`,
			`  Qualified key: ${entry.qualifiedConfigKey}`,
			`  Kind: ${entry.kind}`,
			`  Source: ${entry.source.type}:${entry.source.name}`,
			`  Identity: ${entry.source.identity === undefined ? "none" : "active"}`,
			`  Resource-dependent: ${entry.kind === "tool" ? "yes" : "no"}`,
			entry.conflict ? "  Name conflict: yes" : undefined,
			"",
		]),
	]);
}

function renderExplain(view: Awaited<ReturnType<typeof explainView>>): string {
	if (view.decision === undefined || view.subject === undefined) return view.message ?? "No explanation.";
	return renderLines([
		"Permission explanation",
		"",
		"Subject",
		`  Key: ${view.subject.configKey}`,
		`  Display name: ${view.subject.displayName}`,
		`  Source: ${view.subject.source.type}:${view.subject.source.name}`,
		"",
		"Resolved resource",
		...view.resources.flatMap((resource) => Object.entries(resource).map(([key, value]) => `  ${key}: ${String(value)}`)),
		"",
		"Evaluation",
		...view.decision.trace.flatMap((entry, index) => ["", `  ${index + 1}. ${entry.source}`, `     ${entry.effect}`, `     ${entry.message}`]),
		"",
		"Final decision",
		`  ${view.decision.effect === "hard-deny" ? "HARD DENY" : view.decision.finalEffect.toUpperCase()}`,
	]);
}

function renderRoots(roots: Array<{ id: string; path: string; access: string; source: string }>): string {
	if (roots.length === 0) return "No authorized roots.";
	return renderLines(["File roots", "", ...roots.flatMap((root) => [root.id, `  Path: ${root.path}`, `  Access: ${root.access}`, `  Source: ${root.source}`, ""])]);
}

function renderGrants(view: Awaited<ReturnType<typeof grantsView>>): string {
	const lines = ["Grants", ""];
	for (const [label, grants] of [["Session", view.session], ["Persistent", view.persistent], ["Suspended", view.suspended]] as const) {
		lines.push(label);
		if (grants.length === 0) lines.push("  none");
		for (const grant of grants) lines.push(`  ${grant.id} ${grant.subjectId}`);
		lines.push("");
	}
	return renderLines(lines);
}

function renderValidate(view: Awaited<ReturnType<typeof policyValidateView>>): string {
	if (view.valid) return `Policy ${view.scope}: valid`;
	return renderLines([`Policy ${view.scope}: invalid`, "", renderDiagnostics(view.diagnostics)]);
}

function renderDoctor(findings: Awaited<ReturnType<typeof policyDoctorView>>["findings"]): string {
	if (findings.length === 0) return "Policy doctor: no findings.";
	return renderLines(["Policy doctor", "", ...findings.flatMap((finding) => [`${finding.severity.toUpperCase()} ${finding.code}`, `  ${finding.title}`, `  ${finding.message}`, finding.remediation === undefined ? undefined : `  Recommendation: ${finding.remediation}`, ""])]);
}

function renderEffective(view: Awaited<ReturnType<typeof policyShowView>>): string {
	if (!("effective" in view)) return "";
	return JSON.stringify(view.effective, null, "\t");
}

function renderAuditEntries(entries: Array<{ timestamp: string; finalDecision: string; subject: string; resources: unknown[]; source: string; errorCode?: string }>): string {
	if (entries.length === 0) return "Audit log is empty.";
	return renderLines(entries.flatMap((entry) => [entry.timestamp, `  Decision: ${entry.finalDecision}`, `  Subject: ${entry.subject}`, `  Source: ${entry.source}`, entry.errorCode === undefined ? undefined : `  Error: ${entry.errorCode}`, `  Resources: ${JSON.stringify(entry.resources)}`, ""]));
}

function renderDiagnostics(diagnostics: readonly { file: string; pointer: string; line: number; column: number; message: string }[]): string {
	return diagnostics.slice(0, 100).map((item) => `${item.file}${item.pointer}:${item.line}:${item.column}\n  ${item.message}`).join("\n");
}

function parsePolicyScope(value: string | undefined): "global" | "project" | "all" {
	if (value === undefined) return "all";
	if (value === "global" || value === "project" || value === "all") return value;
	throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions policy validate [global|project|all]");
}

function parsePolicyShowScope(value: string | undefined): "global" | "project" | "effective" {
	if (value === undefined || value === "effective") return "effective";
	if (value === "global" || value === "project") return value;
	throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", "Usage: /permissions policy show [global|project|effective]");
}

function helpFor(path: readonly string[]) {
	const topic = path[0] === "help" ? undefined : path[0];
	return { topic, text: topic === undefined ? ROOT_HELP : SUB_HELP[topic] ?? ROOT_HELP };
}

function renderHelp(help: { text: string }): string {
	return help.text;
}

/** 过滤可选行并生成稳定的人类文本。 */
export function renderLines(lines: readonly (string | undefined)[]): string {
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

const ROOT_HELP = `Permissions commands

  status       Show permission system health
  catalog      List registered tool subjects
  explain      Explain an authorization decision
  set          Set an explicit subject rule
  reset        Remove an explicit subject rule
  roots        Manage authorized file roots
  grants       View or revoke approval grants
  profile      View or change the permission profile
  policy       Validate, inspect, edit, or reload policies
  audit        View permission audit records
  maintenance  Manage temporary maintenance mode

Run:
  /permissions <command> --help`;

const SUB_HELP: Record<string, string> = {
	status: "Usage\n  /permissions status [--json]\n\nSafety notes\n  Shows health only; it does not list all rules.",
	catalog: "Usage\n  /permissions catalog [tools|filter] [--json]\n\nSafety notes\n  Subject allow does not guarantee final allow.",
	explain: "Usage\n  /permissions explain <subject> [request...] [--json]\n\nExamples\n  /permissions explain read ~/data/a.csv\n  /permissions explain bash \"git status\"",
	set: "Usage\n  /permissions set <subject> <allow|ask|deny> --global\n\nSafety notes\n  Writes global policy only.",
	reset: "Usage\n  /permissions reset <subject> --global\n\nSafety notes\n  reset removes explicit policy; it is not the same as ask.",
	roots: "Usage\n  /permissions roots\n  /permissions roots add <path> <read-only|read-write> --global\n  /permissions roots remove <root-id> --global",
	grants: "Usage\n  /permissions grants\n  /permissions grants show <grant-id>\n  /permissions grants revoke <grant-id>\n  /permissions grants clear --session|--persistent|--suspended|--all [--yes]",
	profile: "Usage\n  /permissions profile\n  /permissions profile set <cautious|standard|read-only|unrestricted> --session|--global\n  /permissions profile reset",
	policy: "Usage\n  /permissions policy validate [global|project|all]\n  /permissions policy doctor\n  /permissions policy reload\n  /permissions policy edit [global|project]\n  /permissions policy show [global|project|effective]",
	audit: "Usage\n  /permissions audit\n  /permissions audit tail [count]\n  /permissions audit show <entry-id>",
	maintenance: "Usage\n  /permissions maintenance\n  /permissions maintenance on\n  /permissions maintenance off\n\nSafety notes\n  Maintenance is session-only and is not unrestricted.",
};
