import { useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { AnimatePresence } from "motion/react";
import type { GuiSnapshot, Query } from "../contract.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { NativeSelect } from "./components/ui/native-select";
import { GuiSettings } from "./gui-settings.tsx";
import { ConfigEditor } from "./config-editor.tsx";

export function Settings({ snapshot, guiConfig, send, query, disabled, connected, refreshGuiConfig, restoreFocus }: {
	snapshot: GuiSnapshot | null; guiConfig: GuiConfigDocument | undefined; send: Send; query: Query;
	disabled: boolean; connected: boolean; refreshGuiConfig: () => Promise<void>; restoreFocus: () => void;
}) {
	return <Tabs.Root defaultValue={snapshot ? "agent" : "gui"}>
		<Tabs.List className="settings-tabs" aria-label="设置分类">
			<Tabs.Trigger value="agent" asChild><Button variant="ghost">Agent</Button></Tabs.Trigger>
			<Tabs.Trigger value="gui" asChild><Button variant="ghost">GUI</Button></Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="agent">{snapshot ? <AgentSettings snapshot={snapshot} send={send} query={query} disabled={disabled} restoreFocus={restoreFocus} /> : <p>选择工作区后可修改 Agent 设置。</p>}</Tabs.Content>
		<Tabs.Content value="gui"><GuiSettings document={guiConfig} send={send} disabled={!connected} refresh={refreshGuiConfig} restoreFocus={restoreFocus} /></Tabs.Content>
	</Tabs.Root>;
}

function AgentSettings({ snapshot, send, query, disabled, restoreFocus }: {
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
		{config !== undefined && <ConfigEditor file="settings.json" content={config} send={send} close={() => setConfig(undefined)} restoreFocus={restoreFocus} />}
		</AnimatePresence>
	</>;
}
