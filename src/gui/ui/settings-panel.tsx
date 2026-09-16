import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { GuiSnapshot, Query } from "../contract.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Textarea } from "./components/ui/textarea";
import { NativeSelect } from "./components/ui/native-select";
import { PanelDialog } from "./components/panel-dialog";

export function Settings({ snapshot, send, query, disabled, restoreFocus }: {
	snapshot: GuiSnapshot; send: Send; query: Query; disabled: boolean; restoreFocus: () => void;
}) {
	const settings = snapshot.settings;
	const [config, setConfig] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const active = useRef(true);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const openConfig = async () => {
		setLoading(true);
		setError("");
		try {
			const content = await query({ query: "config", file: "settings.json" });
			if (active.current) setConfig(content);
		} catch (error) {
			if (active.current) setError(error instanceof Error ? error.message : String(error));
		} finally { if (active.current) setLoading(false); }
	};
	return <>
		<div className="settings-grid">
			{([
				["compaction", "自动压缩"], ["retry", "自动重试"], ["autoResize", "自动缩放图片"], ["blockImages", "阻止图片发送"],
			] as const).map(([key, label]) => <label key={key}>
				<Checkbox checked={settings[key]} disabled={disabled}
					onCheckedChange={(checked) => void send({ action: "settings", ...settings, [key]: checked === true })} />{label}
			</label>)}
			{([["steering", "Steer 队列"], ["followUp", "Follow-up 队列"]] as const).map(([key, label]) => <label key={key}>
				{label}<NativeSelect value={settings[key]} disabled={disabled} onChange={(event) => void send({
					action: "settings", ...settings, [key]: event.target.value === "all" ? "all" : "one-at-a-time",
				})}><option value="one-at-a-time">逐条发送</option><option value="all">一起发送</option></NativeSelect>
			</label>)}
		</div>
		{error && <p role="alert">{error}</p>}
		<Button variant="outline" size="sm" disabled={loading} onClick={() => void openConfig()}>编辑完整 settings.json</Button>
		<AnimatePresence>
		{config !== undefined && <ConfigEditor content={config} send={send} close={() => setConfig(undefined)} restoreFocus={restoreFocus} />}
		</AnimatePresence>
	</>;
}

function ConfigEditor({ content, send, close, restoreFocus }: {
	content: string; send: Send; close: () => void; restoreFocus: () => void;
}) {
	const [text, setText] = useState(content || "{}\n");
	return <PanelDialog title="settings.json" close={close} restoreFocus={restoreFocus}>
		<p>保存后重载。文件在编辑期间发生变更时会拒绝覆盖。</p>
		<Textarea aria-label="设置 JSON" className="config-editor" value={text} onChange={(event) => setText(event.target.value)} />
		<Button variant="outline" size="sm" onClick={() => void send({ action: "saveConfig", file: "settings.json", original: content, content: text })
			.then((ok) => { if (ok) close(); })}>保存并重载</Button>
	</PanelDialog>;
}
