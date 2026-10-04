import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { RefreshCw } from "lucide-react";
import type { GlobalQuery, Query } from "../../contract.ts";
import type { StorageGroup } from "../../storage.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { SettingsHeading } from "../settings/settings-controls.tsx";
import { StorageGroupView, storageBytes, storageTotal } from "./storage-group.tsx";
import { StorageConfirmation, type StorageRemoval } from "./storage-confirmation.tsx";
import "./storage.css";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
interface ManagedStorageGroup extends StorageGroup { clear(ids: string[]): Promise<void> }

export function StorageSettings({ query, send, connected, active }: {
	query: Query<GlobalQuery>; send: Send; connected: boolean; active: boolean;
}) {
	const [groups, setGroups] = useState<ManagedStorageGroup[]>([]);
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	const [scanError, setScanError] = useState("");
	const [actionError, setActionError] = useState("");
	const [status, setStatus] = useState("");
	const [removal, setRemoval] = useState<StorageRemoval | null>(null);
	const [deleting, setDeleting] = useState(false);
	useEffect(() => {
		if (!connected || !active) return;
		let current = true;
		setLoading(true); setScanError(""); setRemoval(null);
		const backend = query({ query: "storage" }).then(({ groups }) => groups.map((group): ManagedStorageGroup => ({
			...group,
			async clear(ids) {
				if (!await send({ action: "removeStorage", ids })) throw new Error("清理未完成，请查看错误提示并检查刷新后的结果。");
			},
		})));
		const bridge = window.opi;
		const desktop = bridge ? bridge.readStorage().then((group): ManagedStorageGroup => ({ ...group, clear: bridge.clearStorage })) : Promise.resolve(null);
		void Promise.allSettled([backend, desktop]).then(([backend, desktop]) => {
			if (!current) return;
			const next: ManagedStorageGroup[] = [];
			const errors: string[] = [];
			if (backend.status === "fulfilled") next.push(...backend.value);
			else errors.push(`后端存储：${message(backend.reason)}`);
			if (desktop.status === "fulfilled") { if (desktop.value) next.push(desktop.value); }
			else errors.push(`Desktop 存储：${message(desktop.reason)}`);
			setGroups(next); setScanError(errors.join("\n")); setLoading(false);
		});
		return () => { current = false; };
	}, [query, send, connected, active, revision]);
	const entries = groups.flatMap((group) => group.entries);
	const clear = async (value: StorageRemoval) => {
		setDeleting(true); setActionError(""); setStatus("");
		try {
			await value.clear();
			setStatus("清理完成，列表已重新统计。");
		} catch (error) { setActionError(message(error)); }
		finally { setDeleting(false); setRemoval(null); setRevision((value) => value + 1); }
	};
	const disabled = !connected || loading || deleting;
	return <div className="storage-settings">
		<SettingsHeading title="存储管理">
			<Button variant="outline" size="sm" disabled={!connected || loading || deleting} onClick={() => { setStatus(""); setActionError(""); setRevision((value) => value + 1); }}><RefreshCw aria-hidden="true" />刷新</Button>
		</SettingsHeading>
		{!connected && <p role="status">连接已断开，恢复后重新统计。</p>}
		{loading && connected && <p role="status">正在扫描存储…</p>}
		{scanError && <p role="alert">{scanError}</p>}
		{actionError && <p role="alert">{actionError}</p>}
		{!loading && status && <p role="status">{status}</p>}
		{groups.length > 0 && <>
			<dl className="storage-summary" aria-busy={loading}><div><dt>已识别文件大小</dt><dd>{storageBytes(storageTotal(entries))}</dd></div>
				<div><dt>可清理条目大小</dt><dd>{storageBytes(storageTotal(entries.filter((entry) => !entry.blocked)))}</dd></div>
			</dl>
			<div aria-busy={loading}>{groups.map((group) => <StorageGroupView key={group.id} group={group} disabled={disabled}
				requestRemoval={(entries, trigger, heading) => {
					setActionError(""); setRemoval({ group, entries, trigger, heading, clear: () => group.clear(entries.map((entry) => entry.id)) });
				}} />)}</div>
		</>}
		<AnimatePresence>{removal && <StorageConfirmation value={removal} busy={deleting} disabled={!connected} close={() => setRemoval(null)} confirm={() => void clear(removal)}
			restoreFocus={() => { if (removal.trigger.isConnected && !removal.trigger.disabled) removal.trigger.focus(); else if (removal.heading?.isConnected) removal.heading.focus(); }} />}</AnimatePresence>
	</div>;
}
