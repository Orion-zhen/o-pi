import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Check, GitBranch, ListCollapse, Tag, X } from "lucide-react";
import { Check as CheckIcon, Copy } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { GuiEntry } from "../../../shared/messages/types.ts";
import type { Send } from "@/connection/connection.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { entryMessage, messageContent } from "./tree.ts";
import "./entry-actions.css";

export function EntryActions({ entry, send, children }: { entry: GuiEntry; send: Send; children?: ReactNode }) {
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [copyState, setCopyState] = useState<{ status: "idle" | "copied" | "error" }>({ status: "idle" });
	useEffect(() => {
		if (copyState.status !== "copied") return;
		const timer = setTimeout(() => setCopyState({ status: "idle" }), 1500);
		return () => clearTimeout(timer);
	}, [copyState]);
	if (editing) return <form className="entry-label-editor" onKeyDown={(event) => {
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
		void send({ action: "label", entryId: entry.id, label }).then((ok) => {
			if (ok) setEditing(false);
		}).finally(() => setSaving(false));
	}}>
		<Input autoFocus name="label" aria-label="分支标签" placeholder="添加分支标签" disabled={saving} defaultValue={entry.label ?? ""} />
		<IconButton label="保存标签" size="icon-xs" type="submit" disabled={saving}><Check /></IconButton>
		<IconButton label="取消编辑" size="icon-xs" disabled={saving} onClick={() => setEditing(false)}><X /></IconButton>
	</form>;
	return <>
		{children}
		<div className="entry-actions">
			<IconButton label={copyState.status === "error" ? "复制失败，重试" : copyState.status === "copied" ? "已复制" : "复制"} size="icon-xs" onClick={async () => {
				const value = messageContent(entryMessage(entry));
				const text = typeof value === "string" ? value : value.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
				try {
					await navigator.clipboard.writeText(text);
					setCopyState({ status: "copied" });
				} catch {
					setCopyState({ status: "error" });
				}
			}}><MorphIcon icon={copyState.status === "copied" ? CheckIcon : Copy} spring="smooth" size="1em" /></IconButton>
			<IconButton label="切换到此处" size="icon-xs" onClick={() => void send({ action: "navigate", entryId: entry.id, summarize: false })}><ArrowRight /></IconButton>
			<IconButton label="总结后切换" size="icon-xs" onClick={() => void send({ action: "navigate", entryId: entry.id, summarize: true })}><ListCollapse /></IconButton>
			<IconButton label="创建分支" size="icon-xs" onClick={() => void send({ action: "fork", entryId: entry.id })}><GitBranch /></IconButton>
			<IconButton label="编辑标签" size="icon-xs" onClick={() => setEditing(true)}><Tag /></IconButton>
		</div>
	</>;
}
