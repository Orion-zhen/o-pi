import { memo, useMemo, useCallback } from "react";
import { BookOpen } from "lucide-react";
import { entryMessage, messageContent, type GuiTreeNode } from "./tree.ts";
import { EntryActions } from "./entry-actions.tsx";
import { type GuiEntry, type GuiMessage } from "../../../shared/messages/types.ts";
import { clean } from "@/ui/content/format.ts";
import { SKILL_CONTEXT_MESSAGE } from "../../../../harness/skill-context/types.ts";
import { isSkillLoadDetails, skillLoaders } from "../../../shared/messages/skill-facts.ts";
import type { Send } from "@/connection/connection.ts";
import { useVirtualRows } from "@/ui/use-virtual-rows.ts";
import "./session-tree.css";

interface GraphRow {
	node: GuiTreeNode;
	lane: number;
	incoming: boolean;
}

function graphRows(roots: GuiTreeNode[]): GraphRow[] {
	const pending: GraphRow[] = roots.map((node) => ({ node, lane: 0, incoming: false })).reverse();
	const rows: GraphRow[] = [];
	while (true) {
		const row = pending.pop();
		if (!row) break;
		const children = row.node.children;
		rows.push(row);
		for (const [index, node] of [...children.entries()].reverse()) {
			pending.push({
				node,
				lane: row.lane + children.length - 1 - index,
				incoming: true,
			});
		}
	}
	return rows;
}

export const SessionTree = memo(function SessionTree({ value, send, locate }: { value: GuiTreeNode[]; send: Send; locate: (id: string) => void }) {
	const rows = useMemo(() => graphRows(value), [value]);
	const getKey = useCallback((index: number) => (rows[index] as GraphRow).node.entry.id, [rows]);
	const list = useVirtualRows<HTMLDivElement>(rows.length, getKey, 32);
	if (!rows.length) return <p className="tree-empty">暂无可展示的消息。</p>;
	return (
		<div ref={list.root} style={list.style} className="session-tree" role="list" aria-label="会话消息树">
			{list.rows.map(({ index, key, start }) => <div key={key} data-index={index} ref={list.windowed ? list.virtualizer.measureElement : undefined} style={list.rowStyle(start)}>
				<TreeMessage row={rows[index] as GraphRow} send={send} locate={locate} />
			</div>)}
		</div>
	);
});

function Graph({ row }: { row: GraphRow }) {
	const width = (row.lane + 1) * 14 + 4;
	const x = row.lane * 14 + 9;
	return (
		<svg className="tree-graph" width={width} height="32" viewBox={`0 0 ${width} 32`} preserveAspectRatio="none" aria-hidden="true">
			<g fill="none" stroke="currentColor" strokeWidth="1.5">
				{Array.from({ length: row.lane }, (_, lane) => <path key={lane} d={`M${lane * 14 + 9} 0V32`} />)}
				{row.incoming && <path className="tree-node" d={`M${x} 0V16`} />}
				{row.node.children.map((_, index) => {
					const lane = row.lane + row.node.children.length - 1 - index;
					return <path className={lane === row.lane ? "tree-node" : undefined} key={lane} d={`M${x} 16L${lane * 14 + 9} 32`} />;
				})}
			</g>
			<circle className="tree-node" cx={x} cy="16" r="3" fill="currentColor" />
		</svg>
	);
}

function entryTitle(entry: GuiEntry, message: GuiMessage | undefined): string {
	if (entry.type === "compaction") return "上下文摘要";
	if (entry.type === "branch_summary") return "分支摘要";
	if (entry.type === "custom_message") return "扩展消息";
	switch (message?.role) {
		case "user": return "你";
		case "assistant": return "助手";
		case "bashExecution": return "终端命令";
		case "compactionSummary": return "上下文摘要";
		case "branchSummary": return "分支摘要";
		case "custom": return "扩展消息";
		default: return "消息";
	}
}

function MessagePreview({ message }: { message: GuiMessage | undefined }) {
	const value = messageContent(message);
	const content = typeof value === "string" ? value : value.flatMap((block) => {
		if (block.type === "text") return [block.text];
		return block.type === "image" ? ["[图片]"] : [];
	}).join(" ");
	const text = clean(content || (message?.role === "assistant" ? message.errorMessage ?? "" : ""))
		.replace(/\s+/g, " ").trim();
	const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
	return <p className="tree-message-preview">{preview || "无消息正文"}</p>;
}

function TreeMessage({ row, send, locate }: { row: GraphRow; send: Send; locate: (id: string) => void }) {
	const { node } = row;
	const entry = node.entry;
	const id = entry.id;
	const message = entryMessage(entry);
	const skill = message?.role === "custom" && message.customType === SKILL_CONTEXT_MESSAGE && isSkillLoadDetails(message.details) ? message.details : undefined;
	const skillPreview = skill ? `${skill.name} · ${skill.deduplicated ? "已加载过，未重复注入" : skillLoaders[skill.loadedBy]}` : undefined;
	return (
		<div className="tree-row" role="listitem" data-role={message?.role}>
			<Graph row={row} />
			<strong className="tree-role">{skill && <BookOpen aria-hidden="true" />}{skill ? "技能" : entryTitle(entry, message)}</strong>
			<EntryActions entry={entry} send={send}>
				<button className="tree-jump" onClick={() => locate(id)} aria-label={`定位消息 ${id}`}>
					{skill ? <p className="tree-message-preview">{skillPreview}</p> : <MessagePreview message={message} />}
				</button>
				{entry.label && <span className="tree-label">{entry.label}</span>}
			</EntryActions>
		</div>
	);
}
