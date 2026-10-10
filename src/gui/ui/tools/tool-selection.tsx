import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, LoaderCircle, Save, Search } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import type { GuiSnapshot } from "../../contract.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { SearchInput } from "../components/search-input";
import { settle } from "../lib/motion";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { McpExposureLabel } from "../mcp/mcp-exposure.tsx";

type Tool = GuiSnapshot["tools"][number];

export function ToolSelection({ snapshot, send, disabled: blocked }: { snapshot: Pick<GuiSnapshot, "tools" | "modelTools" | "toolDefaultsChanged">; send: Send; disabled: boolean }) {
	const groupId = useId();
	const [filter, setFilter] = useState("");
	const [saving, setSaving] = useState(false);
	const disabled = blocked || saving;
	const persist = async () => {
		setSaving(true);
		try { await send({ action: "persistTools" }); }
		finally { setSaving(false); }
	};
	const query = filter.trim().toLocaleLowerCase();
	const matches = new Set(snapshot.tools.filter((tool) =>
		`${tool.name} ${tool.description} ${tool.mcpServer?.name ?? ""} ${tool.mcpServer?.tool ?? ""}`.toLocaleLowerCase().includes(query),
	).map((tool) => tool.name));
	const builtin = snapshot.tools.filter((tool) => !tool.mcp);
	const mcp = snapshot.tools.filter((tool) => tool.mcp);
	const codemode = builtin.find((tool) => tool.name === "codemode");
	const enabled = snapshot.modelTools.includes("codemode");
	const children = builtin.filter((tool) => tool.exposure !== "model-only" && matches.has(tool.name));
	const peers = builtin.filter((tool) => matches.has(tool.name) && tool.name !== "codemode" && (!enabled || (tool.exposure === "model-only" && tool.name !== "tool_search")));
	const showCodemode = codemode && (matches.has(codemode.name) || (enabled && children.length > 0));
	const hasResults = showCodemode || (enabled && children.length > 0) || peers.length > 0 || mcp.some((tool) => matches.has(tool.name));
	return <LayoutGroup id={groupId}><div className="tool-selection">
		<div className="tool-selection-toolbar">
			<div className="tool-selection-search">
				<Search aria-hidden="true" />
				<SearchInput aria-label="筛选工具" placeholder="筛选工具或 MCP 服务" value={filter} onValueChange={setFilter} />
			</div>
			<Button title="保存为用户默认" disabled={disabled || !snapshot.toolDefaultsChanged} aria-busy={saving} onClick={() => void persist()}>
				{saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}保存默认
			</Button>
		</div>
		{!hasResults && <p className="tool-selection-empty" role="status">没有匹配的工具</p>}
		{showCodemode && <ToolChoice tool={codemode} send={send} disabled={disabled} nested={false} />}
		{enabled && children.length > 0 && <div className="tool-selection-children">
			{children.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested />)}
		</div>}
		{peers.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested={false} />)}
		{mcp.length > 0 && <McpToolSelection tools={mcp} matches={matches} query={query} send={send} disabled={disabled} />}
	</div></LayoutGroup>;
}

function McpToolSelection({ tools, matches, query, send, disabled }: { tools: Tool[]; matches: Set<string>; query: string; send: Send; disabled: boolean }) {
	const id = useId();
	const servers = new Map<string, Tool[]>();
	const shared: Tool[] = [];
	for (const tool of tools) {
		if (!tool.mcpServer) { shared.push(tool); continue; }
		const group = servers.get(tool.mcpServer.name);
		if (group) group.push(tool); else servers.set(tool.mcpServer.name, [tool]);
	}
	const visibleShared = shared.filter((tool) => matches.has(tool.name));
	return <section className="tool-selection-mcp" aria-labelledby={id} hidden={!tools.some((tool) => matches.has(tool.name))}>
		<h3 id={id}>MCP</h3>
		{[...servers].map(([name, tools]) => <McpToolGroup key={name} name={name} tools={tools} matches={matches} query={query} send={send} disabled={disabled} />)}
		{visibleShared.length > 0 && <div className="mcp-shared-tools"><h4>共享资源工具</h4>
			{visibleShared.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested={false} />)}
		</div>}
	</section>;
}

function McpToolGroup({ name, tools, matches, query, send, disabled }: {
	name: string; tools: Tool[]; matches: Set<string>; query: string; send: Send; disabled: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const [search, setSearch] = useState({ query, expanded: true });
	// 搜索临时展开匹配服务，清空后恢复搜索前的折叠状态。
	if (search.query !== query) setSearch({ query, expanded: true });
	const visible = tools.filter((tool) => matches.has(tool.name));
	const modes = new Set(tools.flatMap((tool) => tool.mcpServer ? [tool.mcpServer.exposure] : []));
	const mode = modes.values().next().value;
	const mixed = modes.size > 1;
	return <Collapsible className="mcp-tool-group" hidden={visible.length === 0}
		open={query ? search.expanded : expanded}
		onOpenChange={(expanded) => { if (query) setSearch({ query, expanded }); else setExpanded(expanded); }}>
		<CollapsibleTrigger className="mcp-tool-group-trigger">
			<ChevronRight className="mcp-tool-group-chevron" aria-hidden="true" />
			<span className="mcp-tool-group-heading"><strong>{name}</strong>
				<span className="mcp-tool-group-mode">{mixed ? "混合" : mode && <McpExposureLabel exposure={mode} />}</span>
			</span>
			<span className="mcp-tool-group-count">{tools.filter((tool) => tool.enabled).length}/{tools.length} 已启用</span>
		</CollapsibleTrigger>
		<CollapsibleContent lazy><div className="mcp-tool-group-tools">
			{visible.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested={false} showExposure={mixed} />)}
		</div></CollapsibleContent>
	</Collapsible>;
}

function ToolChoice({ tool, send, disabled, nested, showExposure = false }: { tool: Tool; send: Send; disabled: boolean; nested: boolean; showExposure?: boolean }) {
	const id = useId();
	const name = tool.mcpServer?.tool ?? tool.name;
	const alwaysCallable = nested && !tool.mcp && (tool.exposure === "codemode" || tool.exposure === "deferred");
	const locked = disabled || !tool.available || tool.name === "tool_search";
	return <motion.div className="list-row" data-tool-option={tool.name} layout="position" layoutId={tool.name} transition={settle}>
		{alwaysCallable ? <Check className="tool-callable-icon" aria-hidden="true" /> : <Checkbox id={id} aria-label={tool.name}
			checked={tool.enabled} disabled={locked}
			onCheckedChange={(checked) => void send({ action: "tool", name: tool.name, enabled: checked === true })} />}
		<div className="tool-choice-details">
			<div className="tool-choice-heading">
				{alwaysCallable ? <strong>{name}</strong> : <label className="tool-name" htmlFor={id} title={tool.name} data-disabled={locked || undefined}><strong>{name}</strong></label>}
				{alwaysCallable && <small className="tool-callable-state">{tool.callable ? "可调用" : "不可调用"}{tool.exposure === "deferred" && " · 按需发现"}</small>}
			</div>
			{showExposure && tool.mcpServer && <small className="tool-choice-exposure"><McpExposureLabel exposure={tool.mcpServer.exposure} /></small>}
			<ToolDescription name={tool.name} description={tool.description} />
		</div>
	</motion.div>;
}

function ToolDescription({ name, description }: { name: string; description: string }) {
	const id = useId();
	const measureRef = useRef<HTMLSpanElement>(null);
	const [multiline, setMultiline] = useState(false);
	const [height, setHeight] = useState(0);
	const [expanded, setExpanded] = useState(false);
	useLayoutEffect(() => {
		const measure = measureRef.current;
		if (!measure) return;
		const update = () => {
			const height = measure.getBoundingClientRect().height;
			setHeight(height);
			setMultiline(height > parseFloat(getComputedStyle(measure).lineHeight) * 1.5);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(measure);
		return () => observer.disconnect();
	}, [description]);
	const open = multiline && expanded;
	return <small className="tool-description" data-expanded={open} style={{ height: open ? `calc(${height}px + 1lh)` : "1lh" }}>
		<span className="tool-description-measure" aria-hidden="true"><span ref={measureRef}>{description}</span></span>
		<span className="tool-description-preview" inert={open} aria-hidden={open}><span className="tool-description-text">{description}</span></span>
		{multiline && <span id={id} className="tool-description-full" inert={!open} aria-hidden={!open}><span className="tool-description-text">{description}</span></span>}
		{multiline && <button type="button" className="tool-description-toggle" aria-expanded={open} aria-controls={id}
			aria-label={`${open ? "收起" : "展开"} ${name} 的描述`} onClick={() => setExpanded(!open)}>
			{open ? "收起" : "展开"}<ChevronDown aria-hidden="true" />
		</button>}
	</small>;
}
