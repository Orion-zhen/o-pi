import { useRef } from "react";
import { Tabs } from "radix-ui";
import type { GuiSessionTab } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { SessionTree } from "./session-tree.tsx";
import { StatsReport } from "./reports/stats-report.tsx";
import { TelemetryReport } from "./reports/telemetry-report.tsx";
import { FilePreviewPanel } from "./file-preview.tsx";
import "./reports/reports.css";
import "./session-sidebar.css";

const tabs: { id: GuiSessionTab; title: string }[] = [
	{ id: "tree", title: "会话树" }, { id: "stats", title: "会话统计" }, { id: "telemetry", title: "遥测" },
];

export function SessionSidebar({ gui, locate }: { gui: GuiView; locate: (entryId: string) => void }) {
	const root = useRef<HTMLDivElement>(null);
	const { sessionTab, sessionDetails: details, workbench, selectTab } = gui;
	const active = gui.activeTab === "file" && !workbench.preview ? sessionTab : gui.activeTab;
	return <aside className="session-sidebar" aria-label="会话信息" hidden={!gui.sessionPanelOpen}>
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
			<Tabs.Content value={sessionTab} className="session-tab-body">
				{!details ? <p role="status">正在读取会话信息…</p> : sessionTab === "tree"
					? <SessionTree value={details.tree} send={gui.send} locate={locate} />
					: sessionTab === "stats" ? <StatsReport value={details.stats} /> : <TelemetryReport value={details.telemetry} />}
			</Tabs.Content>
			{workbench.preview && <Tabs.Content value="file" forceMount hidden={active !== "file"} className="session-tab-body" data-file="true">
				<FilePreviewPanel key={workbench.preview.path} preview={workbench.preview} referenceFile={gui.referenceFile} close={() => {
					workbench.closePreview();
					selectTab(sessionTab);
					requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]')?.focus());
				}} />
			</Tabs.Content>}
		</Tabs.Root>
	</aside>;
}
