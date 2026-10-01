import {
	MCP_TYPESCRIPT_PREAMBLE, mcpStructuredContentSchema, renderToolSignature,
} from "@earendil-works/pi-codemode/declarations";
import type { ToolLoadout, ToolLoadoutChanges, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { codemodeHiddenDeclarations } from "./loadout.ts";

export const CODEMODE_DESCRIPTION = `Compose tool calls in a fresh QuickJS sandbox (256 MiB). No Node, filesystem, network or timers.
- Call tools.<name>(args) using the signatures below. Results are objects or text as declared.
- Nested results stay in the script. Emit with text(value) or top-level return (objects become JSON).
- Failed, blocked or invalid calls reject, except failures carrying structured results. Check their status fields.
- Await needed calls. Script completion cancels pending calls. Failures keep partial output but do not undo tool side effects.
- store(key, value) saves JSON across calls on this session branch, only on success. undefined deletes. load(key) returns the value or undefined.
- First-line // @options JSON accepts max_output_tokens (default 10000) and timeout_ms (default none).`;

const DISCOVERY = "Unlisted tools remain callable. searchTools(query: string, options?: {limit?: number, namespace?: string}) returns {name, description}[] with signatures (default limit 8). describeNamespace(name) returns namespace instructions and tool names. Emit results to inspect them.";
const MCP_IMAGES = "MCP results have content blocks and optional structuredContent. Forward image blocks with image(block), or emit image(base64DataUrl).";

interface CatalogEntry {
	name: string;
	text: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/** 按命名空间轮流选择短声明，保留目录预算和延迟发现语义。 */
function selectEntries(groups: readonly CatalogGroup[], budget: number): Set<string> {
	const shown = new Set<string>();
	let queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	while (queues.length > 0) {
		queues = queues.filter((queue) => {
			const next = queue.shift();
			if (!next || next.cost > budget) return false;
			budget -= next.cost;
			shown.add(next.name);
			return queue.length > 0;
		});
	}
	return shown;
}

/** 只改声明，不接管上游脚本执行与工具权限。 */
export function prepareCodemodeLoadout(loadout: ToolLoadout, inlineBudget: number): ToolLoadoutChanges {
	const inline = loadout.callable.filter((tool) => tool.name !== "codemode" && loadout.getExposure(tool.name) !== "deferred");
	const groups = new Map<string, CatalogGroup>();
	for (const tool of inline) {
		const namespace = loadout.getNamespace(tool.name);
		const key = namespace?.name ?? "";
		let group = groups.get(key);
		if (!group) {
			group = { namespace, entries: [] };
			groups.set(key, group);
		}
		const signature = renderToolSignature({
			name: tool.name, inputSchema: { ...tool.parameters }, outputSchema: tool.outputSchema ? { ...tool.outputSchema } : { type: "string" },
		});
		const text = `${tool.description.trim()}\n\`\`\`ts\n${signature}\n\`\`\``;
		group.entries.push({ name: tool.name, text, cost: Math.ceil(text.length / 4) });
	}
	const ordered = [...groups.values()].sort((a, b) => a.namespace === undefined ? -1
		: b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name));
	const shown = selectEntries(ordered, inlineBudget);
	const sections = [CODEMODE_DESCRIPTION, DISCOVERY, MCP_IMAGES];
	if (inline.some((tool) => shown.has(tool.name) && mcpStructuredContentSchema(tool.outputSchema ? { ...tool.outputSchema } : undefined) !== undefined)) {
		sections.push(`\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (visible.length === 0) continue;
		if (namespace) sections.push(`${namespace.name}${namespace.description?.trim() ? `: ${namespace.description.trim()}` : ""}`);
		sections.push(...visible.map((entry) => entry.text));
	}
	return {
		descriptions: { codemode: sections.join("\n\n") },
		hiddenDeclarations: codemodeHiddenDeclarations(loadout.declared.map((tool) => ({ name: tool.name, exposure: loadout.getExposure(tool.name) }))),
	};
}
