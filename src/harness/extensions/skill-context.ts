import { type ToolCallRenderer, type ToolResultRenderer } from "../presentation.ts";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSkillCommands } from "../skill-context/commands.ts";
import { executeSkillLoad, SkillLoadError } from "../skill-context/executor.ts";
import { collectSkillCandidates } from "../skill-context/loader.ts";
import { findVisibleToolCallIds } from "../prune/prune.ts";
import { type SkillCandidate, type SkillLoadDetails, type SkillToolErrorDetails } from "../skill-context/types.ts";
import { defineToolTelemetry } from "../telemetry/projection.ts";
import { registerTool } from "../register-tool.ts";

interface SkillRendererModule {
	registerSkillMessageRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void;
	renderSkillCall: ToolCallRenderer;
	renderSkillResult(
		details: unknown,
		...args: Parameters<ToolResultRenderer> extends [unknown, ...infer Rest] ? Rest : never
	): ReturnType<ToolResultRenderer>;
}

const skillParameters = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			description: "Skill name from <model_invocable_skills>; use filesystem tools for skill:// paths.",
		}),
	},
	{ additionalProperties: false },
);

type SkillToolDetails = SkillLoadDetails | SkillToolErrorDetails;

/** 注册模型与手动技能披露，并维护分支内的资源权限；native renderer 只在 TUI session 激活。 */
export function createSkillContextExtension(
	loadRenderers?: () => Promise<SkillRendererModule>,
): (pi: ExtensionAPI) => void {
	return function skillContextExtension(pi: ExtensionAPI): void {
		registerSkillCommands(pi);
		const skillTool = registerSkillTool(pi);

		let nativeRendererLoad: Promise<void> | undefined;
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui" || loadRenderers === undefined) return;
			nativeRendererLoad ??= loadRenderers().then((renderers) => {
				renderers.registerSkillMessageRenderer(pi);
				pi.registerTool({
					...skillTool,
					renderCall: renderers.renderSkillCall,
					renderResult(result, options, theme, context) {
						return renderers.renderSkillResult(result.details, options, theme, context);
					},
				});
			});
			await nativeRendererLoad;
		});
	};
}

const skillContextExtension = createSkillContextExtension();

export default skillContextExtension;

function registerSkillTool(pi: ExtensionAPI) {
	let modelCandidates: SkillCandidate[] = [];
	pi.on("before_agent_start", (event) => {
		modelCandidates = collectSkillCandidates(event.systemPromptOptions, []);
	});

	const tool = registerTool(pi, {
		tool: {
			name: "skill",
			label: "skill",
			executionMode: "sequential",
			description: "Load one model-invocable skill by name.",
			promptSnippet: "load one indexed skill",
			parameters: skillParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					if (params.name.startsWith("skill://")) {
						throw new SkillLoadError(
							"SKILL_PATH_USE_FILESYSTEM",
							`Use a filesystem tool with path "${params.name}" instead.`,
						);
					}
					const branch = ctx.sessionManager.getBranch();
					const contextMessages = ctx.sessionManager.buildSessionProjection().messages;
					const result = await executeSkillLoad(pi, {
						name: params.name,
						loadedBy: "agent",
						candidates: modelCandidates,
						branch,
						toolCallId: _toolCallId,
						visibleToolCallIds: findVisibleToolCallIds(contextMessages, branch),
					});
					return { content: [{ type: "text", text: result.content }], details: result.details };
				} catch (error) {
					const message = error instanceof Error ? error.message : "skill loading failed.";
					const details: SkillToolErrorDetails = {
						status: "failed",
						error: {
							code: error instanceof SkillLoadError ? error.code : "SKILL_INVALID",
							message,
						},
					};
					return { content: [{ type: "text", text: `<error tool="skill">${escapeXml(message)}</error>` }], details };
				}
			},
		},
		telemetry: defineToolTelemetry<{ name: string }, SkillToolDetails>({
			input: ({ name }) => ({ fields: { skill: name } }),
			result: (_params, details) =>
				"deduplicated" in details
					? {
							fields: {
								skill: details.name,
								scope: details.scope,
								loaded_by: details.loadedBy,
								content_hash: details.contentHash,
								deduplicated: details.deduplicated,
							},
						}
					: { fields: { status: "failed" } },
		}),
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "skill") return;
		if (isFailedSkillDetails(event.details)) return { isError: true };
	});
	return tool;
}

function isFailedSkillDetails(value: unknown): value is SkillToolErrorDetails {
	return typeof value === "object" && value !== null && "status" in value && value.status === "failed";
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
