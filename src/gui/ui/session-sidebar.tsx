import { Tabs } from "radix-ui";
import { RefreshCw, X } from "lucide-react";
import type { GuiAction, GuiEvent } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import type { Send } from "./dialog.tsx";
import { IconButton } from "./components/icon-button";
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

export const sessionViews = {
	会话树: { action: "tree" },
	会话统计: { action: "view", view: "stats" },
	遥测: { action: "view", view: "telemetry" },
} as const satisfies Record<SessionPanel["title"], GuiAction>;
const titles = Object.keys(sessionViews) as SessionPanel["title"][];

export function SessionSidebar({ gui, panel }: { gui: GuiView; panel: SessionPanel }) {
	const disabled = !gui.snapshot || gui.snapshot.busy || gui.status !== "已连接";
	const changeTree: Send = async (action) => {
		const ok = await gui.send(action);
		if (ok && (action.action === "label" || action.action === "navigate")) await gui.send({ action: "tree" });
		return ok;
	};
	return (
		<aside className="session-sidebar" aria-label="会话信息">
			<Tabs.Root value={panel.title} className="session-tabs" onValueChange={(title) => {
				const tab = titles.find((tab) => tab === title);
				if (tab) void gui.send(sessionViews[tab]);
			}}>
				<div className="session-sidebar-header">
					<Tabs.List aria-label="会话信息" className="session-tab-list">
						{titles.map((title) => <Tabs.Trigger key={title} value={title} disabled={disabled}>
							{title}
						</Tabs.Trigger>)}
					</Tabs.List>
					<div className="session-sidebar-actions">
						<IconButton label="刷新会话信息" disabled={disabled} onClick={() => void gui.send(sessionViews[panel.title])}>
							<RefreshCw />
						</IconButton>
						<IconButton label="收起会话信息" onClick={() => {
							gui.setSessionPanelOpen(false);
							gui.editor.current?.focus();
						}}><X /></IconButton>
					</div>
				</div>
				<Tabs.Content value={panel.title} className="session-tab-body">
					{panel.type === "panel" ? <SessionTree value={panel.value} send={changeTree} /> : <ReportPanel report={panel} />}
				</Tabs.Content>
			</Tabs.Root>
		</aside>
	);
}
