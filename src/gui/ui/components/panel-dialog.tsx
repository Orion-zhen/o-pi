import type { ReactNode, Ref } from "react";
import { X } from "lucide-react";
import { IconButton } from "./icon-button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

export function PanelDialog({ title, ref, children, close, restoreFocus }: {
	title: string;
	ref?: Ref<HTMLDivElement>;
	children: ReactNode;
	close: () => void;
	restoreFocus: () => void;
}) {
	return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
		<DialogContent
			ref={ref}
			className="panel"
			aria-describedby={undefined}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				restoreFocus();
			}}
		>
			<DialogHeader className="panel-header">
				<DialogTitle>{title}</DialogTitle>
				<DialogClose asChild>
					<IconButton label="关闭面板"><X /></IconButton>
				</DialogClose>
			</DialogHeader>
			<div className="panel-body">{children}</div>
		</DialogContent>
	</Dialog>;
}
