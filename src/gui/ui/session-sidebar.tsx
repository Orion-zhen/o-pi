import { useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import type { GuiEvent } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { SessionTree } from "./session-tree.tsx";
import { ReportPanel } from "./reports/report-panel.tsx";
import { FilePreviewPanel } from "./file-preview.tsx";
import "./session-sidebar.css";

export type SessionPanel =
	| { type: "panel"; title: "会话树"; value: unknown }
	| Extract<GuiEvent, { type: "report"; title: "会话统计" | "遥测" }>;

export function isSessionPanel(event: GuiEvent): event is SessionPanel {
	return (event.type === "panel" && event.title === "会话树") ||
		(event.type === "report" && (event.title === "会话统计" || event.title === "遥测"));
}
const titles: SessionPanel["title"][] = ["会话树", "会话统计", "遥测"];

export function SessionSidebar({ gui, locate }: { gui: GuiView; locate: (entryId: string) => void }) {
	const [title, setTitle] = useState<SessionPanel["title"] | "文件">(gui.sessionPanel?.title ?? "会话树");
	const [sessionTitle, setSessionTitle] = useState<SessionPanel["title"]>(gui.sessionPanel?.title ?? "会话树");
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (gui.sessionPanel) { setTitle(gui.sessionPanel.title); setSessionTitle(gui.sessionPanel.title); }
	}, [gui.sessionPanel]);
	useEffect(() => { if (gui.workbench.preview) setTitle("文件"); }, [gui.workbench.selection]);
	const active = title === "文件" && !gui.workbench.preview ? sessionTitle : title;
	const details = gui.sessionDetails;
	return <aside className="session-sidebar" aria-label="会话信息" hidden={!gui.sessionPanelOpen}>
		<Tabs.Root ref={root} value={active} className="session-tabs" onValueChange={(value) => {
			if (value === "文件") { setTitle(value); return; }
			const tab = titles.find((tab) => tab === value);
			if (tab) { setTitle(tab); setSessionTitle(tab); }
		}}>
			<div className="session-sidebar-header">
				<Tabs.List aria-label="会话信息" className="session-tab-list">
					{titles.map((title) => <Tabs.Trigger key={title} value={title}>{title}</Tabs.Trigger>)}
					{gui.workbench.preview && <Tabs.Trigger value="文件">文件</Tabs.Trigger>}
				</Tabs.List>
			</div>
			<Tabs.Content value={sessionTitle} className="session-tab-body">
				{!details ? <p role="status">正在读取会话信息…</p> : sessionTitle === "会话树"
					? <SessionTree value={details.tree} send={gui.send} locate={locate} />
					: <ReportPanel report={sessionTitle === "会话统计" ? { title: sessionTitle, value: details.stats } : { title: sessionTitle, value: details.telemetry }} />}
			</Tabs.Content>
			{gui.workbench.preview && <Tabs.Content value="文件" forceMount hidden={active !== "文件"} className="session-tab-body" data-file="true">
				<FilePreviewPanel key={gui.workbench.preview.path} gui={gui} close={() => {
					gui.workbench.closePreview();
					setTitle(sessionTitle);
					requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]')?.focus());
				}} />
			</Tabs.Content>}
		</Tabs.Root>
	</aside>;
}
