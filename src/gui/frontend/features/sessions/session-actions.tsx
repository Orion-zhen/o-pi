import { useRef } from "react";
import { AppWindow, BookOpen, Braces, BrainCog, Ellipsis, Import } from "lucide-react";
import type { GuiPanel } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem,
	DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

export function SessionActions({ gui }: { gui: { canSubmit: boolean; send: Send; setPanel: (panel: GuiPanel | undefined) => void } }) {
	const panel = useRef<GuiPanel | undefined>(undefined);
	return <DropdownMenu>
		<DropdownMenuTrigger asChild>
			<IconButton label="会话操作" disabled={!gui.canSubmit}><Ellipsis /></IconButton>
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
			if (!panel.current) return;
			event.preventDefault();
			gui.setPanel(panel.current);
			panel.current = undefined;
		}}>
			<DropdownMenuLabel>当前会话</DropdownMenuLabel>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "view", view: "system" })}>
				<BrainCog />系统提示词
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => { panel.current = { kind: "help" }; }}><BookOpen />命令帮助</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem disabled={!gui.canSubmit} onSelect={() => { panel.current = { kind: "import" }; }}><Import />导入会话</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "export", format: "jsonl" })}><Braces />导出 JSONL</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "export", format: "html" })}><AppWindow />导出 HTML</DropdownMenuItem>
		</DropdownMenuContent>
	</DropdownMenu>;
}
