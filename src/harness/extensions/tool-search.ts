import { createToolSearchExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasSearchableTools, isSearchableTool } from "../tool-search/loadout.ts";

const DESCRIPTION = "Search unloaded tools and load matches for the next call.";
const parameters = Type.Object({
	query: Type.String({ description: "Tool name or English keywords.", minLength: 1 }),
	// SDK 会截断 integer 输入，使用 multipleOf 在校验层拒绝小数。
	limit: Type.Optional(Type.Number({ description: "Maximum matches. Default 3.", minimum: 1, multipleOf: 1 })),
});

/** 保留上游检索与会话激活，只精简发现入口。 */
export default function toolSearch(pi: ExtensionAPI): void {
	createToolSearchExtension()({
		...pi,
		registerTool(tool) {
			pi.registerTool<typeof parameters, unknown>({
				name: tool.name,
				label: tool.label,
				exposure: "model-only",
				defaultActive: false,
				parameters,
				description: DESCRIPTION,
				promptSnippet: "Find and load tools.",
				promptGuidelines: [],
				prepareLoadout(loadout) {
					const candidates = loadout.registered.map((tool) => ({ name: tool.name, exposure: loadout.getExposure(tool.name) }));
					if (!hasSearchableTools(candidates, loadout.declared.map((tool) => tool.name))) {
						// 装配完成后再停用，避免重入 SDK 的工具装配。先隐藏本轮声明。
						queueMicrotask(() => {
							const active = pi.getActiveTools();
							if (active.includes("tool_search") && !hasSearchableTools(pi.getAllTools(), active)) {
								pi.setActiveTools(active.filter((name) => name !== "tool_search"));
							}
						});
						return { hiddenDeclarations: ["tool_search"] };
					}
					const sources = new Map<string, string>();
					for (const candidate of candidates) {
						if (!isSearchableTool(candidate)) continue;
						const source = loadout.getNamespace(candidate.name);
						if (!source || sources.has(source.name)) continue;
						const summary = source.description?.trim().split(/\r?\n/)[0];
						sources.set(source.name, summary ? `${source.name}: ${summary}` : source.name);
					}
					return { descriptions: {
						tool_search: [DESCRIPTION, ...sources.values()].join("\n"),
					} };
				},
				async execute(id, args, signal, update, ctx) {
					if (!args.query.trim()) throw new Error("query must not be empty");
					const limit = args.limit ?? 3;
					const active = pi.getActiveTools();
					const exact = pi.getAllTools().find((candidate) =>
						candidate.name === args.query.trim() && isSearchableTool(candidate) && !active.includes(candidate.name));
					if (exact) {
						pi.setActiveTools([...active, exact.name]);
						return { content: [{ type: "text", text: `Loaded: ${exact.name}` }], details: { loaded: [exact.name] } };
					}
					// 工厂只注册 tool_search，桥接公开注册接口擦除的参数与结果类型。
					const input: unknown = { ...args, limit };
					const result = await tool.execute(id, input as Parameters<typeof tool.execute>[1], signal, update, ctx);
					const { loaded } = result.details as { loaded: string[] };
					return { ...result, content: [{ type: "text", text: loaded.length ? `Loaded: ${loaded.join(", ")}` : "No matches." }] };
				},
			});
		},
	});
}
