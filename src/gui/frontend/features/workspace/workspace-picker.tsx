import { useState } from "react";
import { ChevronsUpDown, FolderOpen, Shield } from "lucide-react";
import { FolderOpen as FolderOpenData } from "lucide";
import { MorphIcon } from "morphicons/react";
import { FilledShield } from "@/ui/icon-shapes.ts";
import { Button } from "@/ui/button.tsx";
import { PopoverTrigger } from "@/ui/popover.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { type ActivityState } from "@/features/sessions/use-session-activity.ts";
import { ActivityBorder } from "@/features/sessions/activity-border.tsx";
import { WorkspaceSelection, type WorkspaceSelectionMode, type WorkspaceSelectionView } from "./workspace-selection.tsx";

export function WorkspacePicker({ gui, close, compact = false }: { gui: WorkspaceSelectionView; close: () => void; compact?: boolean }) {
	const [mode, setMode] = useState<WorkspaceSelectionMode>("closed");
	const cwd = gui.cwd;
	const elsewhere = gui.activity.filter((item) => item.cwd !== cwd);
	const elsewhereWaiting = elsewhere.some((item) => item.state === "waiting");
	const state: ActivityState = elsewhereWaiting ? "waiting"
		: elsewhere.some((item) => item.unread) ? "unread"
		: elsewhere.some((item) => item.state === "running" || item.state === "loading") ? "running" : "idle";
	const status = state === "waiting" ? "有会话等待审批" : state === "unread" ? "有未读结果" : "其他工作区有会话运行中";
	return <WorkspaceSelection gui={gui} mode={mode} onModeChange={setMode} purpose="navigate" select={async (directory) => {
		if (directory !== cwd) await gui.globalSend({ action: "workspace", path: directory });
		close();
	}}>{(disabled) => <Hint content={cwd} disabled={mode === "list"}><PopoverTrigger asChild><Button variant="outline" role="combobox" aria-label="工作区" aria-expanded={mode === "list"}
		className="workspace-select activity-frame" aria-description={state === "idle" ? cwd : `${cwd}\n${status}`} disabled={disabled}>
		<ActivityBorder state={state} />
		{compact ? <MorphIcon icon={elsewhereWaiting ? FilledShield : FolderOpenData} spring="smooth" size="1em"
			className={elsewhereWaiting ? "approval-marker" : undefined} {...(elsewhereWaiting ? { label: "其他工作区等待审批" } : {})} /> : <FolderOpen />}
		{!compact && <span>{cwd.split(/[/\\]/).filter(Boolean).at(-1) || "选择工作区"}</span>}
		{!compact && elsewhereWaiting && <Shield className="approval-marker" fill="currentColor" role="img" aria-label="其他工作区等待审批" />}
		{!compact && <ChevronsUpDown />}
	</Button></PopoverTrigger></Hint>}</WorkspaceSelection>;
}
