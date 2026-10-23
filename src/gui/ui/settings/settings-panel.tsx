import { useEffect, useId, useMemo, useState } from "react";
import { Tabs } from "radix-ui";
import { motion } from "motion/react";
import type { GuiSnapshot, Query, GlobalQuery } from "../../contract.ts";
import type { GuiConfigDocument } from "../../preferences.ts";
import type { ModuleConfigId } from "../../module-config.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { AnimatedBackground } from "../components/motion-primitives/animated-background";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { AgentSettings } from "./agent-settings.tsx";
import { NotificationSettings } from "./notification-settings.tsx";
import { GuiSettings } from "../preferences/gui-settings.tsx";
import { ModuleSettings } from "./module-settings.tsx";
import { LspServers } from "./lsp-servers.tsx";
import { McpSettings } from "../mcp/mcp-settings.tsx";
import { ModelServicesSettings } from "../model-services/model-services-settings.tsx";
import { StorageSettings } from "../storage/storage-settings.tsx";
import { SettingsActions, SettingsHeading, SettingsSection } from "./settings-controls.tsx";
import { settingsCategories, type SettingsCategory } from "./settings-navigation.ts";
import { SettingsCategoryContext, SettingsStateContext, useSettingsCoordinator } from "./settings-state.tsx";

export function Settings({ snapshot, guiConfig, send, query, globalQuery, disabled, connected, refreshGuiConfig, restoreFocus, onDirty, initialCategory }: {
	snapshot: GuiSnapshot | null; guiConfig: GuiConfigDocument | undefined; send: Send; query: Query; globalQuery: Query<GlobalQuery>;
	disabled: boolean; connected: boolean; refreshGuiConfig: () => Promise<void>; restoreFocus: () => void;
	onDirty: (dirty: boolean) => void;
	initialCategory?: "mcp" | undefined;
}) {
	useEffect(() => { void refreshGuiConfig(); }, [refreshGuiConfig]);
	const initial = initialCategory === "mcp" ? "connections" : "appearance";
	const [{ category, direction }, setSelection] = useState<{ category: string; direction: number }>({ category: initial, direction: 0 });
	const highlightId = useId();
	const [visited, setVisited] = useState<Set<string>>(() => new Set([initial]));
	const coordinator = useSettingsCoordinator(onDirty);
	const { register, saving, dirtyPages } = coordinator;
	const state = useMemo(() => ({ register, saving }), [register, saving]);
	const selectCategory = (id: string) => {
		setSelection((previous) => {
			// Radix 的聚焦与点击可连续通知同一分类，保留首次计算的方向。
			if (previous.category === id) return previous;
			return { category: id, direction: Math.sign(
				settingsCategories.findIndex((item) => item.id === id) - settingsCategories.findIndex((item) => item.id === previous.category),
			) };
		});
		setVisited((previous) => new Set([...previous, id]));
	};
	const module = (id: ModuleConfigId, title: string) => <ModuleSettings id={id} title={title} query={globalQuery} send={send}
		disabled={!connected} models={snapshot?.models ?? []} tools={snapshot?.tools ?? null} />;
	const guiProps = { document: guiConfig, send, query: globalQuery, disabled: !connected, refresh: refreshGuiConfig, restoreFocus };
	const content = (id: SettingsCategory) => {
		switch (id) {
			case "appearance": return <GuiSettings title="外观" section="appearance" {...guiProps} />;
			case "conversation": return <>
				<GuiSettings title="对话交互" section="interaction" {...guiProps} />
				<NotificationSettings />
				{snapshot ? <AgentSettings key={snapshot.sessionId} snapshot={snapshot} send={send} query={query} disabled={disabled} restoreFocus={restoreFocus} />
					: <SettingsSection title="会话行为"><p className="settings-empty">未选择工作区</p></SettingsSection>}
				{module("autoTitle", "自动标题")}
			</>;
			case "tools": return <>{module("bashTool", "终端执行")}{module("fileTools", "文件访问")}{module("lsp", "代码智能")}
				<LspServers key={snapshot?.cwd} cwd={snapshot?.cwd} query={query} connected={connected} active={category === "tools"} />
			</>;
			case "models": return <ModelServicesSettings globalQuery={globalQuery} query={query} send={send} disabled={!connected}
				sessionId={snapshot?.sessionId} sessionRevision={snapshot?.modelServicesRevision} sessionReady={snapshot?.canSubmit ?? false} />;
			case "web": return module("webTools", "网络与网页");
			case "agents": return module("subagent", "子代理");
			case "security": return module("approvalGate", "权限与安全");
			case "connections": return <>
				<McpSettings query={globalQuery} send={send} disabled={!connected} />
				<GuiSettings title="桌面 Web 访问" section="desktopWeb" {...guiProps} />
				{module("discordPresence", "Discord 状态")}
			</>;
			case "storage": return <StorageSettings query={globalQuery} send={send} connected={connected} active={category === "storage"} />;
			case "terminal": return module("tui", "终端界面");
		}
	};
	return <SettingsStateContext value={state}>
		<Tabs.Root className="settings-shell" orientation="vertical" value={category} onValueChange={selectCategory}>
			<aside className="settings-navigation">
				<motion.div className="settings-navigation-scroll" layoutScroll>
					<Tabs.List className="settings-tabs" aria-label="设置分类">
						{[...new Set(settingsCategories.map(({ group }) => group))].map((group) => <div className="settings-nav-group" key={group}>
							<span className="settings-nav-heading">{group}</span>
							{settingsCategories.filter((item) => item.group === group).map(({ id, label, icon: Icon }) => <Tabs.Trigger key={id} value={id} asChild>
								<Button variant="ghost" className="animated-background-target" aria-label={label} aria-description={dirtyPages.has(id) ? "未保存" : undefined}>
									<AnimatedBackground active={category === id} layoutId={highlightId} /><Icon aria-hidden="true" /><span>{label}</span>
									{dirtyPages.has(id) && <span className="settings-unsaved" aria-hidden="true">•</span>}
								</Button>
							</Tabs.Trigger>)}
						</div>)}
					</Tabs.List>
					<div className="settings-category-select">
						<Select value={category} onValueChange={selectCategory}>
							<SelectTrigger aria-label="设置分类"><SelectValue /></SelectTrigger>
							<SelectContent>{settingsCategories.map(({ id, label }) => <SelectItem key={id} value={id}>{label}{dirtyPages.has(id) ? " •" : ""}</SelectItem>)}</SelectContent>
						</Select>
					</div>
				</motion.div>
				<SettingsActions count={dirtyPages.size} saving={saving} disabled={!connected} blocked={coordinator.blocked}
					error={coordinator.error} status={coordinator.status} save={() => void coordinator.save()} discard={coordinator.discard} />
			</aside>
			{settingsCategories.map(({ id, label }) => <Tabs.Content key={id} value={id} forceMount asChild><motion.div className="settings-content" layoutScroll>
				<SettingsCategoryContext value={id}><div className="gui-settings" data-direction={direction}>
					{visited.has(id) && <>{id !== "storage" && <SettingsHeading title={label} />}{content(id)}</>}
				</div></SettingsCategoryContext>
			</motion.div></Tabs.Content>)}
		</Tabs.Root>
	</SettingsStateContext>;
}
