import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { GuiSnapshot, Query } from "../../contract.ts";
import type { Send } from "../runtime/connection.ts";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ConfigEditor } from "./config-editor.tsx";
import { SettingsRow, SettingsSection, SettingsSourceButton } from "./settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "./settings-state.tsx";

export function AgentSettings({ snapshot, send, query, disabled, restoreFocus }: {
	snapshot: GuiSnapshot; send: Send; query: Query; disabled: boolean; restoreFocus: () => void;
}) {
	const controlId = useId();
	const [draft, setDraft] = useState<GuiSnapshot["settings"]>();
	const settings = draft ?? snapshot.settings;
	const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
	const { saving } = useSettingsState();
	const [error, setError] = useState("");
	useSettingsDraft("agent", {
		title: "会话行为", dirty, blocked: disabled,
		save: async () => {
			setError("");
			if (!await send({ action: "settings", ...settings })) {
				setError("保存失败，草稿已保留。");
				return false;
			}
			setDraft(undefined);
			return true;
		},
		discard: () => { setDraft(undefined); setError(""); },
	});
	const blocked = disabled || saving;
	const change = (next: GuiSnapshot["settings"]) => {
		setDraft(JSON.stringify(next) === JSON.stringify(snapshot.settings) ? undefined : next);
		setError("");
	};
	const [config, setConfig] = useState<string>();
	const [loading, setLoading] = useState(false);
	const active = useRef(true);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const openConfig = async () => {
		setLoading(true); setError("");
		try {
			const content = await query({ query: "config", file: "settings.json" });
			if (active.current) setConfig(content);
		} catch (error) {
			if (active.current) setError(error instanceof Error ? error.message : String(error));
		} finally { if (active.current) setLoading(false); }
	};
	const toggles = (items: readonly (readonly ["compaction" | "retry" | "autoResize" | "blockImages", string])[]) =>
		<div className="settings-fields">{items.map(([key, label]) => <SettingsRow key={key} label={label} htmlFor={`${controlId}-${key}`}>
			<Checkbox id={`${controlId}-${key}`} aria-label={label} checked={settings[key]} disabled={blocked}
				onCheckedChange={(checked) => change({ ...settings, [key]: checked === true })} />
		</SettingsRow>)}</div>;
	return <div className="settings-module">
		<SettingsSection title="消息队列" actions={<SettingsSourceButton file="settings.json" disabled={loading || blocked || dirty} onClick={() => void openConfig()} />}>
			<div className="settings-fields">{([["steering", "运行中消息"], ["followUp", "后续消息"]] as const).map(([key, label]) => <SettingsRow key={key} label={label} htmlFor={`${controlId}-${key}`}>
				<Select value={settings[key]} disabled={blocked} onValueChange={(value) => change({ ...settings, [key]: value === "all" ? "all" : "one-at-a-time" })}>
					<SelectTrigger id={`${controlId}-${key}`} aria-label={label}><SelectValue /></SelectTrigger>
					<SelectContent><SelectItem value="one-at-a-time">逐条发送</SelectItem><SelectItem value="all">一起发送</SelectItem></SelectContent>
				</Select>
			</SettingsRow>)}</div>
		</SettingsSection>
		<SettingsSection title="图片处理">{toggles([["autoResize", "自动缩放图片"], ["blockImages", "阻止图片发送"]])}</SettingsSection>
		<SettingsSection title="会话维护">{toggles([["compaction", "自动压缩"], ["retry", "自动重试"]])}</SettingsSection>
		{error && <p role="alert">{error}</p>}
		<AnimatePresence>{config !== undefined && <ConfigEditor file="settings.json" content={config} send={send} close={() => setConfig(undefined)} restoreFocus={restoreFocus} />}</AnimatePresence>
	</div>;
}
