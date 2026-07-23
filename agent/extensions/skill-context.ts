import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSkillCommands } from "../../src/skill-context/commands.js";
import { executeSkillLoad, SkillLoadError } from "../../src/skill-context/executor.js";
import { collectSkillCandidates } from "../../src/skill-context/loader.js";
import { registerSkillMessageRenderer, renderSkillCall, renderSkillResult } from "../../src/skill-context/renderer.js";
import type { SkillCandidate, SkillLoadDetails, SkillToolErrorDetails } from "../../src/skill-context/types.js";
import { defineToolTelemetry } from "../../src/telemetry/projection.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";

const skillParameters = Type.Object({
	name: Type.String({ minLength: 1, description: "Skill name from <model_invocable_skills>; use read for skill:// resources." }),
}, { additionalProperties: false });

type SkillToolDetails = SkillLoadDetails | SkillToolErrorDetails;

/** 注册模型与手动技能披露，并维护分支内的资源权限。 */
export default function skillContextExtension(pi: ExtensionAPI): void {
	registerSkillMessageRenderer(pi);
	registerSkillCommands(pi);
	registerSkillTool(pi);
}

function registerSkillTool(pi: ExtensionAPI): void {
	let modelCandidates: SkillCandidate[] = [];
	pi.on("before_agent_start", (event) => {
		modelCandidates = collectSkillCandidates(event.systemPromptOptions, []);
	});

	registerObservedTool(pi, {
		tool: {
			name: "skill",
			label: "skill",
			description: "Load one model-invocable skill by name.",
			promptSnippet: "load one indexed skill",
			parameters: skillParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					if (params.name.startsWith("skill://")) {
						throw new SkillLoadError(
							"SKILL_RESOURCE_USE_READ",
							`Use the read tool with path "${params.name}" instead.`,
						);
					}
					const result = await executeSkillLoad(pi, {
						name: params.name,
						loadedBy: "agent",
						candidates: modelCandidates,
						branch: ctx.sessionManager.getBranch(),
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
			renderCall: renderSkillCall,
			renderResult(result, options, theme, context) {
				return renderSkillResult(result.details, options, theme, context);
			},
		},
		telemetry: defineToolTelemetry<{ name: string }, SkillToolDetails>({
			input: ({ name }) => ({ fields: { skill: name } }),
			result: (_params, result) => result.details !== undefined && "deduplicated" in result.details
				? { fields: {
					skill: result.details.name,
					scope: result.details.scope,
					loaded_by: result.details.loadedBy,
					content_hash: result.details.contentHash,
					deduplicated: result.details.deduplicated,
				} }
				: { fields: { status: "failed" } },
		}),
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "skill") return;
		if (isFailedSkillDetails(event.details)) return { isError: true };
	});
}

function isFailedSkillDetails(value: unknown): value is SkillToolErrorDetails {
	return typeof value === "object" && value !== null && "status" in value && value.status === "failed";
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
