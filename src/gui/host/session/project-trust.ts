import { realpathSync } from "node:fs";
import path from "node:path";
import {
	hasTrustRequiringProjectResources,
	type DefaultProjectTrust, type LoadExtensionsResult, type ProjectTrustContext, type ProjectTrustEventResult,
	type ProjectTrustStore, type ProjectTrustUpdate,
} from "@earendil-works/pi-coding-agent";

interface TrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
}

/** 宿主优先复用会话决策，其余信任流程对齐 SDK。 */
export async function resolveProjectTrusted(options: {
	cwd: string;
	trustStore: ProjectTrustStore;
	defaultProjectTrust: DefaultProjectTrust;
	extensionsResult: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext & { hasUI: true };
	onExtensionError(message: string): void;
}): Promise<boolean> {
	const { cwd, trustStore, projectTrustContext: ctx } = options;
	if (!hasTrustRequiringProjectResources(cwd)) return trustStore.get(cwd) ?? true;

	const handlers = options.extensionsResult.extensions.map((extension) => ({
		path: extension.path, handlers: [...(extension.handlers.get("project_trust") ?? [])],
	}));
	for (const extension of handlers) for (const handler of extension.handlers) {
		let result: ProjectTrustEventResult;
		try {
			const value: unknown = await handler({ type: "project_trust", cwd }, ctx);
			if (typeof value !== "object" || value === null || !("trusted" in value)
				|| value.trusted !== "yes" && value.trusted !== "no" && value.trusted !== "undecided") throw new Error("无效 project_trust 决策");
			result = { trusted: value.trusted, remember: "remember" in value && value.remember === true };
		} catch (error) {
			options.onExtensionError(`${extension.path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (result.trusted === "undecided") continue;
		const trusted = result.trusted === "yes";
		if (result.remember === true) trustStore.set(cwd, trusted);
		return trusted;
	}
	const saved = trustStore.get(cwd);
	if (saved !== null) return saved;
	if (options.defaultProjectTrust !== "ask") return options.defaultProjectTrust === "always";

	const resolved = realpathSync(cwd);
	const parent = path.dirname(resolved);
	const choices: TrustOption[] = [
		{ label: "信任项目", trusted: true, updates: [{ path: resolved, decision: true }] },
		...(parent === resolved ? [] : [{ label: `信任父目录 (${parent})`, trusted: true,
			updates: [{ path: parent, decision: true }, { path: resolved, decision: null }] }]),
		{ label: "仅本次信任", trusted: true, updates: [] },
		{ label: "不信任项目", trusted: false, updates: [{ path: resolved, decision: false }] },
		{ label: "仅本次不信任", trusted: false, updates: [] },
	];
	const answer = await ctx.ui.select(`信任项目：${cwd}`, choices.map((choice) => choice.label));
	const choice = choices.find(({ label }) => label === answer);
	if (!choice) return false;
	if (choice.updates.length) trustStore.setMany(choice.updates);
	return choice.trusted;
}
