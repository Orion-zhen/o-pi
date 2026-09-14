import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 真实 CLI 的离线模型边界，工具和会话仍走正式执行链。 */
export default function fixtureProvider(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "opi-fixture",
		models: [{ id: "test", reasoning: true }],
		tokensPerSecond: 100_000,
	});
	pi.registerProvider("opi-fixture", {
		api: faux.api,
		baseUrl: "http://localhost:0",
		apiKey: "fixture-key",
		models: faux.models,
		streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
	});
	pi.registerCommand("opi-fixture", { description: "CLI integration fixture", handler: async () => {} });
	pi.registerCommand("opi-fixture-reload", { description: "Reload CLI resources", handler: async (_args, ctx) => ctx.reload() });
	pi.on("resources_discover", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.notify(`fixture-editor:${ctx.ui.getEditorComponent() ? "custom" : "default"}`);
	});
	const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		faux.setResponses([tool("read", { path: "sample.ts" }), (context) => fauxAssistantMessage(JSON.stringify({
			entry: process.argv[1],
			prompt: context.systemPrompt,
			results: context.messages.filter((message) => message.role === "toolResult"),
		}))]);
	} else if (process.env.PI_OPI_TEST_SCENARIO === "tools") {
		faux.setResponses([
			tool("ls", { path: "." }),
			tool("find", { query: "sample" }),
			tool("read", { path: "sample.ts" }),
			tool("grep", { query: "value", path: ["sample.ts", "large.ts"] }),
			tool("edit", { path: "sample.ts", edits: [{ old: "value = 1", new: "value = 2" }] }),
			tool("write", { path: "created.txt", content: "written by opi\n" }),
			tool("bash", { command: "printf opi-bash" }),
			fauxAssistantMessage("tools completed"),
		]);
	} else if (process.env.PI_OPI_TEST_SCENARIO === "approval") {
		faux.setResponses([tool("bash", { command: "printenv" }), fauxAssistantMessage("approval completed")]);
	} else if (process.env.PI_OPI_TEST_SCENARIO === "subagent") {
		faux.setResponses([
			tool("subagent", { tasks: [{ agent: "scout", task: "Read sample.ts" }] }),
			fauxAssistantMessage("subagent completed"),
		]);
	} else {
		const echo: FauxResponseFactory = (context) => fauxAssistantMessage(JSON.stringify(context));
		faux.setResponses(Array.from({ length: 8 }, () => echo));
	}
}
