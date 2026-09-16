import type { ReactNode, Ref } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
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
			showCloseButton={false}
			aria-describedby={undefined}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				restoreFocus();
			}}
		>
			<DialogHeader className="panel-header">
				<DialogTitle>{title}</DialogTitle>
				<DialogClose asChild>
					<Button variant="ghost" size="icon" aria-label="关闭面板" title="关闭面板"><X /></Button>
				</DialogClose>
			</DialogHeader>
			<div className="panel-body">{children}</div>
		</DialogContent>
	</Dialog>;
}
