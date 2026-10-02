import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import type { GuiSnapshot } from "../contract.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { settle } from "./lib/motion";

type Tool = GuiSnapshot["tools"][number];

export function ToolSelection({ snapshot, send, disabled }: { snapshot: Pick<GuiSnapshot, "tools" | "modelTools">; send: Send; disabled: boolean }) {
	const groupId = useId();
	const codemode = snapshot.tools.find((tool) => tool.name === "codemode");
	const enabled = snapshot.modelTools.includes("codemode");
	const children = snapshot.tools.filter((tool) => tool.exposure !== "model-only");
	const peers = snapshot.tools.filter((tool) => tool.name !== "codemode" && (!enabled || (tool.exposure === "model-only" && tool.name !== "tool_search")));
	return <LayoutGroup id={groupId}><div className="tool-selection">
		<p>{enabled ? "模型通过 codemode 调用子工具，其余入口保持独立。" : "选择向模型开放的工具，在当前分支生效。"}</p>
		<Button variant="outline" size="sm" disabled={disabled} onClick={() => void send({ action: "persistTools" })}>保存为用户默认</Button>
		{codemode && <ToolChoice tool={codemode} send={send} disabled={disabled} nested={false} />}
		{enabled && <div className="tool-selection-children">
			{children.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested />)}
		</div>}
		{peers.map((tool) => <ToolChoice key={tool.name} tool={tool} send={send} disabled={disabled} nested={false} />)}
	</div></LayoutGroup>;
}

function ToolChoice({ tool, send, disabled, nested }: { tool: Tool; send: Send; disabled: boolean; nested: boolean }) {
	const id = useId();
	const alwaysCallable = nested && !tool.mcp && (tool.exposure === "codemode" || tool.exposure === "deferred");
	const locked = disabled || !tool.available || tool.name === "tool_search";
	return <motion.div className="list-row" data-tool-option={tool.name} layout="position" layoutId={tool.name} transition={settle}>
		{alwaysCallable ? <Check className="tool-callable-icon" aria-hidden="true" /> : <Checkbox id={id} aria-label={tool.name}
			checked={tool.enabled} disabled={locked}
			onCheckedChange={(checked) => void send({ action: "tool", name: tool.name, enabled: checked === true })} />}
		<div className="tool-choice-details">
			<div className="tool-choice-heading">
				{alwaysCallable ? <strong>{tool.name}</strong> : <label className="tool-name" htmlFor={id} data-disabled={locked || undefined}><strong>{tool.name}</strong></label>}
				{alwaysCallable && <small className="tool-callable-state">{tool.callable ? "可调用" : "不可调用"}{tool.exposure === "deferred" && " · 按需发现"}</small>}
			</div>
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
