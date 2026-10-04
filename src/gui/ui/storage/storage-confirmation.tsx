import { useRef, useState } from "react";
import type { StorageEntry, StorageGroup } from "../../storage.ts";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { storageBytes, storageTotal } from "./storage-group.tsx";

export interface StorageRemoval { group: StorageGroup; entries: StorageEntry[]; trigger: HTMLButtonElement; heading: HTMLButtonElement | null; clear(): Promise<void> }

export function StorageConfirmation({ value, busy, disabled, close, confirm, restoreFocus }: {
	value: StorageRemoval; busy: boolean; disabled: boolean; close: () => void; confirm: () => void; restoreFocus: () => void;
}) {
	const [acknowledged, setAcknowledged] = useState(false);
	const cancel = useRef<HTMLButtonElement>(null);
	return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
		<DialogContent className="storage-confirmation" onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
			onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}
			onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
			<DialogHeader><DialogTitle>删除{value.group.title}？</DialogTitle>
				<DialogDescription>{value.entries.length} 个条目，共 {storageBytes(storageTotal(value.entries))}。删除后无法恢复。</DialogDescription>
			</DialogHeader>
			<ul className="storage-confirmation-list">{value.entries.slice(0, 5).map((entry) => <li key={entry.id}><strong>{entry.name}</strong><code>{entry.path}</code></li>)}</ul>
			{value.entries.length > 5 && <p className="settings-description">另有 {value.entries.length - 5} 个条目</p>}
			<label className="storage-select storage-consent"><Checkbox checked={acknowledged} disabled={busy} onCheckedChange={(value) => setAcknowledged(value === true)} />
				<span>我已关闭其他 Pi / opi 实例，确认删除共享数据。</span>
			</label>
			<div className="storage-confirmation-actions"><Button ref={cancel} variant="outline" disabled={busy} onClick={close}>取消</Button>
				<Button variant="destructive" disabled={busy || disabled || !acknowledged} aria-busy={busy} onClick={confirm}>{busy ? "正在删除…" : "确认删除"}</Button></div>
		</DialogContent>
	</Dialog>;
}
