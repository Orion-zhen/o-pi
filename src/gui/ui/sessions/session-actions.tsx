import { useRef } from "react";
import { AppWindow, BookOpen, Braces, BrainCog, Ellipsis, Import } from "lucide-react";
import type { GuiPanel } from "../../contract.ts";
import type { GuiControls } from "../app/gui-controls.ts";
import { IconButton } from "../components/icon-button";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem,
	DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

export function SessionActions({ gui }: { gui: Pick<GuiControls, "canSubmit" | "canChangeSession" | "send" | "setPanel"> }) {
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
			<DropdownMenuItem disabled={!gui.canChangeSession} onSelect={() => { panel.current = { kind: "import" }; }}><Import />导入会话</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "export", format: "jsonl" })}><Braces />导出 JSONL</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "export", format: "html" })}><AppWindow />导出 HTML</DropdownMenuItem>
		</DropdownMenuContent>
	</DropdownMenu>;
}
