import { useState } from "react";
import { Ellipsis, Trash2 } from "lucide-react";
import type { GuiAction } from "../contract.ts";
import type { Send } from "./dialog.tsx";
import { IconButton } from "./components/icon-button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

export function HistoryMenu({
	label,
	action,
	disabled,
	send,
	close,
}: {
	label: string;
	action: Extract<GuiAction, { action: "deleteSession" | "deleteWorkspace" }>;
	disabled: boolean;
	send: Send;
	close: () => void;
}) {
	const [pending, setPending] = useState(false);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<IconButton label={label} className="history-menu-trigger" size="icon-sm" disabled={disabled || pending}>
					<Ellipsis />
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					variant="destructive"
					onSelect={() => {
						setPending(true);
						close();
						void send(action).finally(() => setPending(false));
					}}
				>
					<Trash2 />
					{action.action === "deleteWorkspace" ? "删除工作区" : "删除会话"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
