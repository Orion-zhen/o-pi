import { useState } from "react";
import { ArrowRight, Check, GitBranch, ListCollapse, Tag, X } from "lucide-react";
import { clean, record } from "./content.tsx";
import type { Send } from "./dialog.tsx";
import { IconButton } from "./components/icon-button";
import { Input } from "./components/ui/input";
import "./session-tree.css";

type TreeNode = Record<string, unknown> & { entry: Record<string, unknown> };

function nodes(value: unknown): TreeNode[] {
	return Array.isArray(value)
		? value.filter((node): node is TreeNode => record(node) && record(node.entry))
		: [];
}

interface GraphRow {
	node: TreeNode;
	lane: number;
	rails: number[];
	incoming: boolean;
	outgoing: number[];
}

function graphRows(roots: TreeNode[]): GraphRow[] {
	const pending: Omit<GraphRow, "outgoing">[] = roots.map((node) => ({ node, lane: 0, rails: [], incoming: false })).reverse();
	const rows: GraphRow[] = [];
	while (true) {
		const row = pending.pop();
		if (!row) break;
		const children = nodes(row.node.children);
		const outgoing = children.map((_, index) => row.lane + children.length - 1 - index);
		rows.push({ ...row, outgoing });
		for (const [index, node] of [...children.entries()].reverse()) {
			pending.push({
				node,
				lane: row.lane + children.length - 1 - index,
				rails: [...row.rails, ...outgoing.slice(index + 1)],
				incoming: true,
			});
		}
	}
	return rows;
}

export function SessionTree({ value, send }: { value: unknown; send: Send }) {
	const rows = graphRows(nodes(value));
	if (!rows.length) return <p className="tree-empty">暂无可展示的消息。</p>;
	const width = (rows.reduce((max, row) => Math.max(max, row.lane), 0) + 1) * 14 + 4;
	return (
		<div className="session-tree" role="list" aria-label="会话消息树">
			{rows.map((row) => <TreeMessage key={String(row.node.entry.id)} row={row} graphWidth={width} send={send} />)}
		</div>
	);
}

function Graph({ row, width }: { row: GraphRow; width: number }) {
	const x = row.lane * 14 + 9;
	return (
		<svg className="tree-graph" width={width} height="32" viewBox={`0 0 ${width} 32`} preserveAspectRatio="none" aria-hidden="true">
			<g fill="none" stroke="currentColor" strokeWidth="1.5">
				{row.rails.map((lane) => <path key={lane} d={`M${lane * 14 + 9} 0V32`} />)}
				{row.incoming && <path d={`M${x} 0V16`} />}
				{row.outgoing.map((lane) => <path key={lane} d={`M${x} 16L${lane * 14 + 9} 32`} />)}
			</g>
			<circle cx={x} cy="16" r="3" fill="currentColor" />
		</svg>
	);
}

function entryTitle(entry: Record<string, unknown>, message: Record<string, unknown>): string {
	if (entry.type === "compaction") return "上下文摘要";
	if (entry.type === "branch_summary") return "分支摘要";
	if (entry.type === "custom_message") return "扩展消息";
	switch (message.role) {
		case "user": return "你";
		case "assistant": return "助手";
		case "bashExecution": return "终端命令";
		case "compactionSummary": return "上下文摘要";
		case "branchSummary": return "分支摘要";
		case "custom": return "扩展消息";
		default: return "消息";
	}
}

function MessagePreview({ message }: { message: Record<string, unknown> }) {
	const value = message.role === "bashExecution" ? message.command : message.summary ?? message.content;
	const content = typeof value === "string" ? value : Array.isArray(value)
		? value.flatMap((block) => {
			if (!record(block)) return [];
			if (block.type === "text" && typeof block.text === "string") return [block.text];
			return block.type === "image" ? ["[图片]"] : [];
		}).join(" ") : "";
	const text = clean(content || (typeof message.errorMessage === "string" ? message.errorMessage : ""))
		.replace(/\s+/g, " ").trim();
	const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
	return <p className="tree-message-preview">{preview || "无消息正文"}</p>;
}

function TreeMessage({ row, graphWidth, send }: { row: GraphRow; graphWidth: number; send: Send }) {
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const { node } = row;
	const entry = node.entry;
	const id = String(entry.id);
	const message = entry.type === "message" && record(entry.message) ? entry.message : entry;
	return (
		<div className="tree-row" role="listitem" data-role={typeof message.role === "string" ? message.role : undefined}>
			<Graph row={row} width={graphWidth} />
			<strong className="tree-role">{entryTitle(entry, message)}</strong>
			{editing ? (
				<form className="tree-label-editor" onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						if (!saving) setEditing(false);
					}
				}} onSubmit={(event) => {
					event.preventDefault();
					if (saving) return;
					const label = new FormData(event.currentTarget).get("label");
					if (typeof label !== "string") return;
					setSaving(true);
					void send({ action: "label", entryId: id, label }).then((ok) => {
						if (ok) setEditing(false);
					}).finally(() => setSaving(false));
				}}>
					<Input autoFocus name="label" aria-label="分支标签" placeholder="添加分支标签" disabled={saving} defaultValue={typeof node.label === "string" ? node.label : ""} />
					<IconButton label="保存标签" size="icon-xs" type="submit" disabled={saving}><Check /></IconButton>
					<IconButton label="取消编辑" size="icon-xs" disabled={saving} onClick={() => setEditing(false)}><X /></IconButton>
				</form>
			) : (
				<>
					<MessagePreview message={message} />
					{typeof node.label === "string" && node.label && <span className="tree-label" title={node.label}>{node.label}</span>}
					<div className="tree-row-actions">
						<IconButton label="切换到此处" size="icon-xs" onClick={() => void send({ action: "navigate", entryId: id, summarize: false })}><ArrowRight /></IconButton>
						<IconButton label="总结后切换" size="icon-xs" onClick={() => void send({ action: "navigate", entryId: id, summarize: true })}><ListCollapse /></IconButton>
						<IconButton label="创建分支" size="icon-xs" onClick={() => void send({ action: "fork", entryId: id })}><GitBranch /></IconButton>
						<IconButton label="编辑标签" size="icon-xs" onClick={() => setEditing(true)}><Tag /></IconButton>
					</div>
				</>
			)}
		</div>
	);
}
