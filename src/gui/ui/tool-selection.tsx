import { useState } from "react";
import { Check, ChevronRight, CodeXml } from "lucide-react";
import type { GuiSnapshot } from "../contract.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";

type Tool = GuiSnapshot["tools"][number];

export function ToolSelection({ snapshot, send, disabled }: { snapshot: Pick<GuiSnapshot, "tools" | "modelTools">; send: Send; disabled: boolean }) {
	const [expanded, setExpanded] = useState(true);
	const codemode = snapshot.tools.find((tool) => tool.name === "codemode");
	const enabled = snapshot.modelTools.includes("codemode");
	const children = snapshot.tools.filter((tool) => tool.exposure !== "model-only");
	const peers = snapshot.tools.filter((tool) => tool.name !== "codemode" && (!enabled || (tool.exposure === "model-only" && tool.name !== "tool_search")));
	return <div className="tool-selection">
		<p>{enabled ? "模型通过 codemode 调用子工具，其余入口保持独立。" : "选择向模型开放的工具，在当前分支生效。"}</p>
		<Button variant="outline" size="sm" disabled={disabled} onClick={() => void send({ action: "persistTools" })}>保存为用户默认</Button>
		{codemode && <Collapsible className="tool-mode" open={enabled && expanded} onOpenChange={setExpanded}>
			<div className="list-row" data-tool-option="codemode">
				<Checkbox aria-label="codemode" checked={codemode.enabled} disabled={disabled || !codemode.available}
					onCheckedChange={(checked) => void send({ action: "tool", name: "codemode", enabled: checked === true })} />
				<CodeXml className="tool-mode-icon" aria-hidden="true" />
				<span><strong>codemode</strong><small>通过 JavaScript 编排子工具</small></span>
				{enabled && <CollapsibleTrigger className="tool-mode-toggle" aria-label="展开或收起子工具">
					{children.filter((tool) => tool.callable).length} 个可用子工具<ChevronRight className={expanded ? "expanded" : ""} aria-hidden="true" />
				</CollapsibleTrigger>}
			</div>
			{enabled && <CollapsibleContent className="tool-selection-children" lazy>
				{children.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested />)}
			</CollapsibleContent>}
		</Collapsible>}
		{peers.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested={false} />)}
	</div>;
}

function ToolChoice({ tool, send, disabled, nested }: { tool: Tool; send: Send; disabled: boolean; nested: boolean }) {
	const alwaysCallable = nested && !tool.mcp && (tool.exposure === "codemode" || tool.exposure === "deferred");
	if (tool.name === "tool_search") return <div className="list-row" data-tool-option={tool.name}>
		<span><strong>tool_search</strong><small>普通模式下有未加载工具时自动启用。</small></span>
		<small className="tool-callable-state">{tool.enabled ? "已启用" : "无可搜索工具"}</small>
	</div>;
	const description = <span><strong>{tool.name}</strong><small>{tool.mcp ? `MCP · 当前分支可见性。${tool.description}` : tool.description}</small></span>;
	if (alwaysCallable) return <div className="list-row" data-tool-option={tool.name}>
		<Check className="tool-callable-icon" aria-hidden="true" />{description}
		<small className="tool-callable-state">{tool.callable ? "可调用" : "不可调用"}{tool.exposure === "deferred" && " · 按需发现"}</small>
	</div>;
	return <label className="list-row" data-tool-option={tool.name}>
		<Checkbox aria-label={tool.name} checked={tool.enabled} disabled={disabled || !tool.available}
			onCheckedChange={(checked) => void send({ action: "tool", name: tool.name, enabled: checked === true })} />
		{description}
	</label>;
}
