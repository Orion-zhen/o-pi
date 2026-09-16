import { useEffect, useState } from "react";
import { Tabs } from "radix-ui";
import type { GuiEvent } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { SessionTree } from "./session-tree.tsx";
import { ReportPanel } from "./reports/report-panel.tsx";
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
	const [title, setTitle] = useState<SessionPanel["title"]>(gui.sessionPanel?.title ?? "会话树");
	useEffect(() => { if (gui.sessionPanel) setTitle(gui.sessionPanel.title); }, [gui.sessionPanel]);
	const details = gui.sessionDetails;
	return <aside className="session-sidebar" aria-label="会话信息" hidden={!gui.sessionPanelOpen}>
		<Tabs.Root value={title} className="session-tabs" onValueChange={(value) => {
			const tab = titles.find((tab) => tab === value);
			if (tab) setTitle(tab);
		}}>
			<div className="session-sidebar-header">
				<Tabs.List aria-label="会话信息" className="session-tab-list">
					{titles.map((title) => <Tabs.Trigger key={title} value={title}>{title}</Tabs.Trigger>)}
				</Tabs.List>
			</div>
			<Tabs.Content value={title} className="session-tab-body">
				{!details ? <p role="status">正在读取会话信息…</p> : title === "会话树"
					? <SessionTree value={details.tree} send={gui.send} locate={locate} />
					: <ReportPanel report={title === "会话统计" ? { title, value: details.stats } : { title, value: details.telemetry }} />}
			</Tabs.Content>
		</Tabs.Root>
	</aside>;
}
