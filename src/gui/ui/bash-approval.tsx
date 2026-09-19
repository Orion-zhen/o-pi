import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { GuiBashApproval } from "../contract.ts";
import { SyntaxHighlighter } from "./code-highlight.ts";
import createCodeElement from "react-syntax-highlighter/dist/esm/create-element";
import type { createElementProps } from "react-syntax-highlighter";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { ListScroll } from "./components/list-scroll.tsx";
import "./bash-approval.css";

export function bashPreview(command: string): string {
	let preview = "";
	let characters = 0;
	let lines = 1;
	for (const character of command) {
		if (characters === 240 || character === "\n" && lines === 4) break;
		preview += character;
		characters++;
		if (character === "\n") lines++;
	}
	return preview;
}

function CommandCode({ command, limit }: { command: string; limit?: number }) {
	return <div className="code-block approval-command-code">
		<SyntaxHighlighter language="bash" useInlineStyles={false} wrapLongLines tabIndex={0}
			renderer={({ rows, ...options }) => {
				if (limit === undefined) return rows.map((node, key) => createCodeElement({ ...options, node, key }));
				let remaining = limit;
				// 先解析完整语法，再裁剪显示，避免截断引号或 heredoc 后丢失高亮。
				const clip = (nodes: createElementProps["node"][]): createElementProps["node"][] => {
					const result: createElementProps["node"][] = [];
					for (const node of nodes) {
						if (remaining === 0) break;
						if (node.type === "text") {
							const value = String(node.value ?? "").slice(0, remaining);
							remaining -= value.length;
							result.push({ ...node, value });
						} else result.push(node.children ? { ...node, children: clip(node.children) } : node);
					}
					return result;
				};
				return clip(rows).map((node, key) => createCodeElement({ ...options, node, key }));
			}}>{command}</SyntaxHighlighter>
	</div>;
}

function BashCommand({ command, label }: { command: string; label: string }) {
	const [expanded, setExpanded] = useState(false);
	const preview = bashPreview(command);
	const truncated = preview !== command;
	return <Collapsible className="approval-command" role="group" aria-label={label} open={expanded} onOpenChange={setExpanded}>
		<div className="approval-command-heading">
			<span>{label}</span>
			{truncated && <CollapsibleTrigger asChild>
				<Button type="button" variant="ghost" size="sm" className="disclosure-trigger">
					<ChevronRight className="disclosure-chevron" aria-hidden="true" />{expanded ? "收起命令" : "展开完整命令"}
				</Button>
			</CollapsibleTrigger>}
		</div>
		{!expanded && <div className="approval-command-preview">
			<CommandCode command={command} limit={preview.length} />
			{truncated && <p className="text-xs text-muted-foreground">… 已折叠，仅显示命令开头</p>}
		</div>}
		{truncated && <CollapsibleContent lazy><CommandCode command={command} /></CollapsibleContent>}
	</Collapsible>;
}

const actionLabels: Record<GuiBashApproval["items"][number]["action"], string> = {
	execute: "执行命令", write_redirect: "写入重定向", write_file: "写入文件", edit_file: "修改文件", fetch_url: "网络请求",
};

export const BashApproval = memo(function BashApproval({ approval }: { approval: GuiBashApproval }) {
	return <ListScroll className="approval-details">
		<div className="space-y-4">
			<p className="approval-cwd text-sm text-muted-foreground">工作目录：<code>{approval.cwd}</code></p>
			<BashCommand command={approval.command} label="Bash 命令" />
			<section aria-label="需要确认的操作" className="space-y-2">
				<h3 className="text-sm font-medium">需要确认的操作</h3>
				<ul className="approval-sensitive-list">
					{approval.items.map((item, index) => <li className="approval-sensitive" key={index}>
						{item.kind === "command" ? item.target === approval.command
							? <p className="approval-target-label">{index + 1}. 整条命令需确认</p>
							: <BashCommand command={item.target} label={`${index + 1}. ${actionLabels[item.action]}`} />
							: <><p className="approval-target-label">{index + 1}. {actionLabels[item.action]}</p><code className="approval-target">{item.target}</code></>}
						<p className="approval-reason text-sm text-muted-foreground">原因：{item.reason}</p>
					</li>)}
				</ul>
			</section>
		</div>
	</ListScroll>;
});
