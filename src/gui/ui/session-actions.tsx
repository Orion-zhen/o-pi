import { BookOpen, Download, Ellipsis, FileJson, Terminal, Upload } from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem,
	DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

export function SessionActions({ gui }: { gui: GuiView }) {
	return <DropdownMenu>
		<DropdownMenuTrigger asChild>
			<IconButton label="会话操作" disabled={!gui.snapshot || gui.snapshot.busy || gui.status !== "已连接"}>
				<Ellipsis />
			</IconButton>
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end">
			<DropdownMenuLabel>当前会话</DropdownMenuLabel>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "view", view: "system" })}>
				<Terminal />系统提示词
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "view", view: "help" })}>
				<BookOpen />命令帮助
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem disabled={gui.running} onSelect={() => void gui.send({ action: "view", view: "import" })}>
				<Upload />导入会话
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "export", format: "jsonl" })}>
				<FileJson />导出 JSONL
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void gui.send({ action: "export", format: "html" })}>
				<Download />导出 HTML
			</DropdownMenuItem>
		</DropdownMenuContent>
	</DropdownMenu>;
}
