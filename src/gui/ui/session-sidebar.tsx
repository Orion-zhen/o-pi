import { useMemo, useRef } from "react";
import { Tabs } from "radix-ui";
import { AnimatePresence } from "motion/react";
import { Fade } from "./components/animated";
import type { GuiSessionTab, GuiSnapshot } from "../contract.ts";
import type { GuiControls } from "./gui-controls.ts";
import type { WorkbenchView } from "./use-workbench.ts";
import type { StatsSnapshot } from "../../harness/stats/types.ts";
import type { LiveTelemetryReport } from "../../harness/telemetry-report/live.ts";
import { sessionTree } from "../messages.ts";
import { SessionTree } from "./session-tree.tsx";
import { StatsReport } from "./reports/stats-report.tsx";
import { TelemetryReport } from "./reports/telemetry-report.tsx";
import { FilePreviewPanel } from "./file-preview.tsx";
import "./reports/reports.css";
import "./session-sidebar.css";

const tabs: { id: GuiSessionTab; title: string }[] = [
	{ id: "tree", title: "会话树" }, { id: "stats", title: "会话统计" }, { id: "telemetry", title: "遥测" },
];

interface SessionSidebarView extends Pick<GuiControls, "send"> {
	snapshot: GuiSnapshot | null;
	sessionStats: StatsSnapshot | undefined;
	telemetry: LiveTelemetryReport | undefined;
	sessionTab: GuiSessionTab;
	activeTab: GuiSessionTab | "file";
	sessionPanelOpen: boolean;
	selectTab: (tab: GuiSessionTab | "file") => void;
	workbench: WorkbenchView;
	referenceFile: (path: string) => void;
}
export function SessionSidebar({ gui, locate }: { gui: SessionSidebarView; locate: (entryId: string) => void }) {
	const root = useRef<HTMLDivElement>(null);
	const { sessionTab, snapshot, sessionStats, telemetry, workbench, selectTab } = gui;
	const tree = useMemo(() => snapshot ? sessionTree(snapshot.entries, snapshot.leafId) : undefined, [snapshot?.entries, snapshot?.leafId]);
	const loading = <p role="status">正在读取会话信息…</p>;
	const active = gui.activeTab === "file" && !workbench.preview ? sessionTab : gui.activeTab;
	return <aside className="session-sidebar" aria-label="会话信息" data-open={gui.sessionPanelOpen} inert={!gui.sessionPanelOpen} aria-hidden={!gui.sessionPanelOpen}>
		<Tabs.Root ref={root} value={active} className="session-tabs" onValueChange={(value) => {
			if (value === "file") selectTab(value);
			else {
				const tab = tabs.find((tab) => tab.id === value);
				if (tab) selectTab(tab.id);
			}
		}}>
			<div className="session-sidebar-header">
				<Tabs.List aria-label="会话信息" className="session-tab-list">
					{tabs.map(({ id, title }) => <Tabs.Trigger key={id} value={id}>{title}</Tabs.Trigger>)}
					{workbench.preview && <Tabs.Trigger value="file">文件</Tabs.Trigger>}
				</Tabs.List>
			</div>
			<Tabs.Content value={sessionTab} forceMount asChild>
				<Fade initial={false} animate={{ opacity: active === "file" ? 0 : 1 }} className="session-tab-body" data-list-scroll data-active={active !== "file"} inert={active === "file"} aria-hidden={active === "file"}>
				<AnimatePresence initial={false} mode="wait" presenceAffectsLayout={false}><Fade key={sessionTab}>
				{sessionTab === "tree" ? tree ? <SessionTree value={tree} send={gui.send} locate={locate} /> : loading
					: sessionTab === "stats" ? sessionStats ? <StatsReport value={sessionStats} /> : loading
					: telemetry ? <TelemetryReport value={telemetry} /> : loading}
				</Fade></AnimatePresence>
				</Fade>
			</Tabs.Content>
			<AnimatePresence initial={false}>
			{workbench.preview && <Tabs.Content value="file" forceMount asChild>
				<Fade animate={{ opacity: active === "file" ? 1 : 0 }} data-active={active === "file"} inert={active !== "file"} aria-hidden={active !== "file"} className="session-tab-body" data-file="true">
				<AnimatePresence initial={false} mode="wait"><Fade key={workbench.preview.path} className="file-preview-frame">
				<FilePreviewPanel preview={workbench.preview} referenceFile={gui.referenceFile} close={() => {
					workbench.closePreview();
					selectTab(sessionTab);
					requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]')?.focus());
				}} />
				</Fade></AnimatePresence>
				</Fade>
			</Tabs.Content>}
			</AnimatePresence>
		</Tabs.Root>
	</aside>;
}
