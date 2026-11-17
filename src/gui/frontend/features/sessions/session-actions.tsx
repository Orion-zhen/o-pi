import { useContext, useRef, useState } from "react";
import { AppWindow, BookOpen, Braces, BrainCog, Ellipsis, FolderInput, Import } from "lucide-react";
import type { GuiPanel } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { NotificationErrorContext, type useNotifications } from "@/ui/notifications.tsx";
import { PopoverAnchor } from "@/ui/popover.tsx";
import { WorkspaceSelection, type WorkspaceSelectionMode, type WorkspaceSelectionView } from "@/features/workspace/workspace-selection.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem,
	DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

export function SessionActions({ workspace, canSubmit, canCopySession, send, setPanel, notifications }: {
	workspace: WorkspaceSelectionView;
	canSubmit: boolean;
	canCopySession: boolean;
	send: Send;
	setPanel: (panel: GuiPanel | undefined) => void;
	notifications: Pick<ReturnType<typeof useNotifications>, "notify">;
}) {
	const notifyError = useContext(NotificationErrorContext);
	const nextAction = useRef<GuiPanel | "restore" | undefined>(undefined);
	const trigger = useRef<HTMLButtonElement>(null);
	const upload = useRef<HTMLInputElement>(null);
	const [mode, setMode] = useState<WorkspaceSelectionMode>("closed");
	return <DropdownMenu>
		<input ref={upload} className="hidden" aria-label="导入会话文件" type="file" accept=".jsonl" onChange={(event) => {
			const file = event.target.files?.[0];
			event.target.value = "";
			if (file) void file.text().then((content) => send({ action: "import", content })).catch(notifyError);
		}} />
		<WorkspaceSelection gui={workspace} mode={mode} onModeChange={setMode} purpose="restore" select={async (directory) => {
			await send({ action: "restoreSession", path: directory });
			notifications.notify(`已复制到 ${directory}`, "info");
		}} onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
			{(disabled) => <PopoverAnchor asChild><DropdownMenuTrigger asChild>
				<IconButton ref={trigger} label="会话操作" disabled={disabled || !canSubmit}><Ellipsis /></IconButton>
			</DropdownMenuTrigger></PopoverAnchor>}
		</WorkspaceSelection>
		<DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
			const action = nextAction.current;
			nextAction.current = undefined;
			if (!action) return;
			event.preventDefault();
			if (action === "restore") setMode("list");
			else setPanel(action);
		}}>
			<DropdownMenuLabel>当前会话</DropdownMenuLabel>
			<DropdownMenuItem onSelect={() => void send({ action: "view", view: "system" }).catch(notifyError)}>
				<BrainCog />系统提示词
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => { nextAction.current = { kind: "help" }; }}><BookOpen />命令帮助</DropdownMenuItem>
			<DropdownMenuSeparator />
			{canCopySession && <DropdownMenuItem onSelect={() => { nextAction.current = "restore"; }}><FolderInput />复制到别处</DropdownMenuItem>}
			<DropdownMenuItem disabled={!canSubmit} onSelect={() => upload.current?.click()}><Import />导入会话</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void send({ action: "export", format: "jsonl" }).catch(notifyError)}><Braces />导出 JSONL</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void send({ action: "export", format: "html" }).catch(notifyError)}><AppWindow />导出 HTML</DropdownMenuItem>
		</DropdownMenuContent>
	</DropdownMenu>;
}
