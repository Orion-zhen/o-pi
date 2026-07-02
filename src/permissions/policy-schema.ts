import type {
	PermissionAction,
	PermissionEffect,
	PermissionPolicyFile,
	PermissionRule,
	PermissionRuleTool,
	ResourceBoundary,
} from "./permission-types.js";
import { permissionActions, permissionEffects, permissionToolNames, resourceBoundaries } from "./permission-types.js";

export const permissionsSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://pi.local/permissions.schema.json",
	type: "object",
	required: ["version"],
	additionalProperties: false,
	properties: {
		$schema: { type: "string" },
		version: { const: 1 },
		tools: { type: "object" },
		defaults: { type: "object" },
		rules: { type: "array" },
	},
	$defs: {
		effect: { enum: ["allow", "ask", "deny"] },
		tool: { enum: ["ls", "read", "edit", "*"] },
	},
} as const;

export interface PolicyValidationError {
	pointer: string;
	message: string;
}

export function validatePolicyFile(value: unknown): { ok: true; policy: PermissionPolicyFile } | { ok: false; errors: PolicyValidationError[] } {
	const errors: PolicyValidationError[] = [];
	if (!isRecord(value)) {
		return { ok: false, errors: [{ pointer: "", message: "Policy must be an object." }] };
	}
	if (value["version"] !== 1) errors.push({ pointer: "/version", message: "version must be 1." });
	const tools = value["tools"];
	if (tools !== undefined) validateToolMap(tools, "/tools", errors);
	const defaults = value["defaults"];
	if (defaults !== undefined) validateDefaults(defaults, errors);
	const rules = value["rules"];
	if (rules !== undefined) validateRules(rules, errors);
	if (errors.length > 0) return { ok: false, errors };

	const policy: PermissionPolicyFile = { version: 1 };
	if (tools !== undefined) policy.tools = tools as Record<string, PermissionEffect>;
	if (defaults !== undefined) policy.defaults = defaults as NonNullable<PermissionPolicyFile["defaults"]>;
	if (rules !== undefined) policy.rules = rules as PermissionRule[];
	return { ok: true, policy };
}

function validateToolMap(value: unknown, pointer: string, errors: PolicyValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ pointer, message: "tools must be an object." });
		return;
	}
	for (const [tool, effect] of Object.entries(value)) {
		if (tool.trim() === "") errors.push({ pointer: `${pointer}/${tool}`, message: "Tool pattern must be non-empty." });
		if (!isEffect(effect)) errors.push({ pointer: `${pointer}/${tool}`, message: "Unknown effect." });
	}
}

function validateDefaults(value: unknown, errors: PolicyValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ pointer: "/defaults", message: "defaults must be an object." });
		return;
	}
	for (const [boundary, tools] of Object.entries(value)) {
		if (!isBoundary(boundary)) {
			errors.push({ pointer: `/defaults/${boundary}`, message: "Unknown boundary." });
			continue;
		}
		if (!isRecord(tools)) {
			errors.push({ pointer: `/defaults/${boundary}`, message: "Boundary defaults must be an object." });
			continue;
		}
		for (const [tool, effect] of Object.entries(tools)) {
			if (!isRuleTool(tool)) errors.push({ pointer: `/defaults/${boundary}/${tool}`, message: "Unknown tool." });
			if (!isEffect(effect)) errors.push({ pointer: `/defaults/${boundary}/${tool}`, message: "Unknown effect." });
		}
	}
}

function validateRules(value: unknown, errors: PolicyValidationError[]): void {
	if (!Array.isArray(value)) {
		errors.push({ pointer: "/rules", message: "rules must be an array." });
		return;
	}
	const ids = new Set<string>();
	value.forEach((item, index) => {
		const pointer = `/rules/${index}`;
		if (!isRecord(item)) {
			errors.push({ pointer, message: "Rule must be an object." });
			return;
		}
		if (typeof item["id"] !== "string" || item["id"].trim() === "") {
			errors.push({ pointer: `${pointer}/id`, message: "Rule id must be a non-empty string." });
		} else if (ids.has(item["id"])) {
			errors.push({ pointer: `${pointer}/id`, message: "Duplicate rule id." });
		} else {
			ids.add(item["id"]);
		}
		if (!isEffect(item["effect"])) errors.push({ pointer: `${pointer}/effect`, message: "Unknown effect." });
		const tools = item["tools"];
		if (!Array.isArray(tools) || tools.length === 0) {
			errors.push({ pointer: `${pointer}/tools`, message: "tools must be a non-empty array." });
		} else {
			tools.forEach((tool, toolIndex) => {
				if (!isRuleTool(tool)) errors.push({ pointer: `${pointer}/tools/${toolIndex}`, message: "Unknown tool." });
			});
		}
		validateResource(item["resource"], `${pointer}/resource`, errors);
	});
}

function validateResource(value: unknown, pointer: string, errors: PolicyValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ pointer, message: "resource must be an object." });
		return;
	}
	if (value["type"] === "path") {
		if (typeof value["path"] !== "string" || value["path"].trim() === "") {
			errors.push({ pointer: `${pointer}/path`, message: "path must be a non-empty string." });
		}
		if (value["scope"] !== "exact" && value["scope"] !== "subtree") {
			errors.push({ pointer: `${pointer}/scope`, message: "scope must be exact or subtree." });
		}
		return;
	}
	if (value["type"] === "boundary") {
		if (!isBoundary(value["boundary"])) errors.push({ pointer: `${pointer}/boundary`, message: "Unknown boundary." });
		return;
	}
	errors.push({ pointer: `${pointer}/type`, message: "resource.type must be path or boundary." });
}

export function isPermissionAction(value: unknown): value is PermissionAction {
	return typeof value === "string" && (permissionActions as readonly string[]).includes(value);
}

export function isPermissionTool(value: unknown): value is import("./permission-types.js").PermissionToolName {
	return typeof value === "string" && (permissionToolNames as readonly string[]).includes(value);
}

export function isRuleTool(value: unknown): value is PermissionRuleTool {
	return value === "*" || isPermissionTool(value);
}

export function isEffect(value: unknown): value is PermissionEffect {
	return typeof value === "string" && (permissionEffects as readonly string[]).includes(value);
}

export function isBoundary(value: unknown): value is ResourceBoundary {
	return typeof value === "string" && (resourceBoundaries as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
