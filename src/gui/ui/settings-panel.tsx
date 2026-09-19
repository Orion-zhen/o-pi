import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { AnimatePresence } from "motion/react";
import { Keyboard, MessageSquare, Palette, Wrench, Globe, Shield, Bot, Code, Plug, Terminal, Type } from "lucide-react";
import type { GuiSnapshot, Query, GlobalQuery } from "../contract.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { GuiSettings } from "./gui-settings.tsx";
import { ConfigEditor } from "./config-editor.tsx";
import { ModuleSettings } from "./module-settings.tsx";
import type { ModuleConfigId } from "../module-config.ts";

export function Settings({ snapshot, guiConfig, send, query, globalQuery, disabled, connected, refreshGuiConfig, restoreFocus, onDirty }: {
	snapshot: GuiSnapshot | null; guiConfig: GuiConfigDocument | undefined; send: Send; query: Query; globalQuery: Query<GlobalQuery>;
	disabled: boolean; connected: boolean; refreshGuiConfig: () => Promise<void>; restoreFocus: () => void;
	onDirty: (dirty: boolean) => void;
}) {
	const [category, setCategory] = useState("appearance");
	const [visited, setVisited] = useState<Set<string>>(() => new Set(["appearance"]));
	const dirtyModules = useRef(new Set<ModuleConfigId>());
	const reportDirty = useCallback((id: ModuleConfigId, dirty: boolean) => {
		if (dirty) dirtyModules.current.add(id); else dirtyModules.current.delete(id);
		onDirty(dirtyModules.current.size > 0);
	}, [onDirty]);
	const selectCategory = (id: string) => { setCategory(id); setVisited((previous) => new Set([...previous, id])); };
	const categories = [
		{ id: "appearance", label: "外观", icon: Palette },
		{ id: "interaction", label: "交互", icon: Keyboard },
		{ id: "agent", label: "会话行为", icon: MessageSquare },
		{ id: "autoTitle", label: "自动标题", icon: Type },
		{ id: "bashTool", label: "终端工具", icon: Terminal },
		{ id: "fileTools", label: "文件工具", icon: Wrench },
		{ id: "tools", label: "默认工具", icon: Wrench },
		{ id: "webTools", label: "网络与网页", icon: Globe },
		{ id: "approvalGate", label: "权限与安全", icon: Shield },
		{ id: "subagent", label: "子代理", icon: Bot },
		{ id: "lsp", label: "代码智能", icon: Code },
		{ id: "discordPresence", label: "集成", icon: Plug },
		{ id: "tui", label: "终端界面", icon: Terminal },
	] as const;
	return <Tabs.Root className="settings-shell" orientation="vertical" value={category} onValueChange={selectCategory}>
		<div className="settings-navigation">
			<Tabs.List className="settings-tabs" aria-label="设置分类">
				{categories.map(({ id, label, icon: Icon }) => <Tabs.Trigger key={id} value={id} asChild>
					<Button variant="ghost"><Icon aria-hidden="true" />{label}</Button>
				</Tabs.Trigger>)}
			</Tabs.List>
			<div className="settings-category-select"><span>设置分类</span>
				<Select value={category} onValueChange={selectCategory}>
					<SelectTrigger aria-label="设置分类"><SelectValue /></SelectTrigger>
					<SelectContent>{categories.map(({ id, label }) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
				</Select>
			</div>
		</div>
		{categories.map(({ id, label }) => <Tabs.Content key={id} value={id} className="settings-content" forceMount>
			<header className="settings-section-heading"><h2>{label}</h2></header>
			{visited.has(id) && (id === "agent" ? snapshot
				? <AgentSettings snapshot={snapshot} send={send} query={query} disabled={disabled} restoreFocus={restoreFocus} />
				: <p className="settings-empty">选择工作区后可修改会话设置。</p>
				: id === "appearance" || id === "interaction"
				? <GuiSettings section={id} document={guiConfig} send={send} disabled={!connected} refresh={refreshGuiConfig} restoreFocus={restoreFocus} />
				: <ModuleSettings id={id} query={globalQuery} send={send} disabled={!connected} onDirty={reportDirty} models={snapshot?.models ?? []} />)}
		</Tabs.Content>)}
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
				{label}<Select value={settings[key]} disabled={disabled} onValueChange={(value) => void send({
					action: "settings", ...settings, [key]: value === "all" ? "all" : "one-at-a-time",
				})}>
					<SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
					<SelectContent><SelectItem value="one-at-a-time">逐条发送</SelectItem><SelectItem value="all">一起发送</SelectItem></SelectContent>
				</Select>
			</label>)}
		</div>
		{error && <p role="alert">{error}</p>}
		<Button variant="outline" size="sm" disabled={loading} onClick={() => void openConfig()}>编辑完整 settings.json</Button>
		<AnimatePresence>
		{config !== undefined && <ConfigEditor file="settings.json" content={config} send={send} close={() => setConfig(undefined)} restoreFocus={restoreFocus} />}
		</AnimatePresence>
	</>;
}
