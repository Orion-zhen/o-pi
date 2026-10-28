import { useId, useMemo, useRef } from "react";
import { Tabs } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Fade } from "@/ui/motion/animated.tsx";
import { AnimatedBackground } from "@/ui/motion/animated-background.tsx";
import { TransitionPanel } from "@/ui/motion/transition-panel.tsx";
import { useSectionEntrance } from "./welcome/startup-entrance.tsx";
import type { GuiSessionTab, GuiSnapshot } from "../../shared/protocol/state.ts";
import type { GuiControls } from "./controls.ts";
import type { WorkbenchView } from "@/features/workspace/use-workbench.ts";
import type { StatsSnapshot } from "../../../harness/stats/types.ts";
import type { LiveTelemetryReport } from "../../../harness/telemetry-report/live.ts";
import { sessionTree } from "@/features/sessions/tree.ts";
import { SessionTree } from "@/features/sessions/session-tree.tsx";
import { StatsReport } from "@/features/reports/stats-report.tsx";
import { TelemetryReport } from "@/features/reports/telemetry-report.tsx";
import { FilePreviewPanel } from "@/features/workspace/preview/file-preview.tsx";
import "@/features/reports/reports.css";
import "./session-inspector.css";

const tabs: { id: GuiSessionTab; title: string }[] = [
	{ id: "tree", title: "会话树" }, { id: "stats", title: "会话统计" }, { id: "telemetry", title: "遥测" },
];

interface SessionInspectorView extends Pick<GuiControls, "send" | "setError"> {
	cwd: string;
	snapshot: GuiSnapshot | null;
	sessionStats: StatsSnapshot | undefined;
	telemetry: LiveTelemetryReport | undefined;
	sessionTab: GuiSessionTab;
	activeTab: GuiSessionTab | "file";
	selectTab: (tab: GuiSessionTab | "file") => void;
	workbench: WorkbenchView;
	referenceFile: (path: string) => boolean;
}
export function SessionInspector({ gui, locate }: { gui: SessionInspectorView; locate: (entryId: string) => void }) {
	const root = useRef<HTMLDivElement>(null);
	const entrance = useSectionEntrance("right");
	const highlightId = useId();
	const { sessionTab, snapshot, sessionStats, telemetry, workbench, selectTab } = gui;
	const tree = useMemo(() => snapshot ? sessionTree(snapshot.entries, snapshot.leafId) : undefined, [snapshot?.entries, snapshot?.leafId]);
	const loading = <p role="status">正在读取会话信息…</p>;
	const active = gui.activeTab === "file" && !workbench.preview ? sessionTab : gui.activeTab;
	return <Tabs.Root asChild value={active} onValueChange={(value) => {
		if (value === "file") selectTab(value);
		else {
			const tab = tabs.find((tab) => tab.id === value);
			if (tab) selectTab(tab.id);
		}
	}}>
	<motion.div ref={root} className="session-tabs" {...(entrance ? { style: entrance } : {})}>
		<div className="session-sidebar-header">
			<Tabs.List aria-label="会话信息" className="session-tab-list">
				{tabs.map(({ id, title }) => <Tabs.Trigger key={id} value={id} className="animated-background-target">
					<AnimatedBackground active={active === id} layoutId={highlightId} />{title}
				</Tabs.Trigger>)}
				{workbench.preview && <Tabs.Trigger value="file" className="animated-background-target">
					<AnimatedBackground active={active === "file"} layoutId={highlightId} />文件
				</Tabs.Trigger>}
			</Tabs.List>
		</div>
		<Tabs.Content value={sessionTab} forceMount asChild>
			<Fade initial={false} animate={{ opacity: active === "file" ? 0 : 1 }} className="session-tab-body" data-list-scroll data-active={active !== "file"} inert={active === "file"} aria-hidden={active === "file"}>
			<TransitionPanel activeIndex={tabs.findIndex(({ id }) => id === sessionTab)}>
				{sessionTab === "tree" ? tree ? <SessionTree value={tree} send={gui.send} locate={locate} /> : loading
					: sessionTab === "stats" ? sessionStats ? <StatsReport value={sessionStats} /> : loading
					: telemetry ? <TelemetryReport value={telemetry} /> : loading}
			</TransitionPanel>
			</Fade>
		</Tabs.Content>
		<AnimatePresence initial={false}>
		{workbench.preview && <Tabs.Content value="file" forceMount asChild>
			<Fade animate={{ opacity: active === "file" ? 1 : 0 }} data-active={active === "file"} inert={active !== "file"} aria-hidden={active !== "file"} className="session-tab-body" data-file="true">
			<AnimatePresence initial={false} mode="wait"><Fade key={workbench.preview.path} className="file-preview-frame">
			<FilePreviewPanel cwd={gui.cwd} setError={gui.setError} preview={workbench.preview} referenceFile={gui.referenceFile} close={() => {
				workbench.closePreview();
				selectTab(sessionTab);
				requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]')?.focus({ preventScroll: true }));
			}} />
			</Fade></AnimatePresence>
			</Fade>
		</Tabs.Content>}
		</AnimatePresence>
	</motion.div>
	</Tabs.Root>;
}
