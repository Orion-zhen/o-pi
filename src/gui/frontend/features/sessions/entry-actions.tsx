import { useState, type ReactNode } from "react";
import { ArrowRight, Check, GitBranch, ListCollapse, Tag, X } from "lucide-react";
import { Check as CheckIcon, Copy } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { GuiEntry } from "../../../shared/messages/types.ts";
import type { Send } from "@/connection/connection.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { useClipboard } from "@/ui/use-clipboard.ts";
import { messageContent, type EntryMessage } from "./tree.ts";
import "./entry-actions.css";

export function EntryActions({ entry, message, send, children }: { entry: GuiEntry; message: EntryMessage; send: Send; children?: ReactNode }) {
	const [label, setLabel] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const clipboard = useClipboard();
	if (label !== null) return <form className="entry-label-editor" onKeyDown={(event) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			if (!saving) setLabel(null);
		}
	}} onSubmit={(event) => {
		event.preventDefault();
		if (saving) return;
		setSaving(true);
		void send({ action: "label", entryId: entry.id, label }).then((ok) => {
			if (ok) setLabel(null);
		}).finally(() => setSaving(false));
	}}>
		<Input autoFocus name="label" aria-label="分支标签" placeholder="添加分支标签" disabled={saving} value={label} onChange={(event) => setLabel(event.target.value)} />
		<IconButton label="保存标签" size="icon-xs" type="submit" disabled={saving}><Check /></IconButton>
		<IconButton label="取消编辑" size="icon-xs" disabled={saving} onClick={() => setLabel(null)}><X /></IconButton>
	</form>;
	return <>
		{children}
		<div className="entry-actions">
			<IconButton label={clipboard.status === "error" ? "复制失败，重试" : clipboard.status === "copied" ? "已复制" : "复制"} size="icon-xs" onClick={() => {
				const value = messageContent(message);
				const text = typeof value === "string" ? value : value.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
				void clipboard.copy(text);
			}}><MorphIcon icon={clipboard.status === "copied" ? CheckIcon : Copy} spring="smooth" size="1em" /></IconButton>
			<IconButton label="切换到此处" size="icon-xs" onClick={() => void send({ action: "navigate", entryId: entry.id, summarize: false })}><ArrowRight /></IconButton>
			<IconButton label="总结后切换" size="icon-xs" onClick={() => void send({ action: "navigate", entryId: entry.id, summarize: true })}><ListCollapse /></IconButton>
			<IconButton label="创建分支" size="icon-xs" onClick={() => void send({ action: "fork", entryId: entry.id })}><GitBranch /></IconButton>
			<IconButton label="编辑标签" size="icon-xs" onClick={() => setLabel(entry.label ?? "")}><Tag /></IconButton>
		</div>
	</>;
}
