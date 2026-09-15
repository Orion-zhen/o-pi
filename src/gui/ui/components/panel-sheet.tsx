import type { ReactNode, Ref } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet";

export function PanelSheet({
	title,
	ref,
	children,
	close,
	restoreFocus,
}: {
	title: string;
	ref?: Ref<HTMLDivElement>;
	children: ReactNode;
	close: () => void;
	restoreFocus: () => void;
}) {
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<SheetContent
				ref={ref}
				className="panel"
				showCloseButton={false}
				aria-describedby={undefined}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					restoreFocus();
				}}
			>
				<SheetHeader className="panel-header">
					<SheetTitle>{title}</SheetTitle>
					<SheetClose asChild>
						<Button variant="ghost" size="icon" aria-label="关闭面板" title="关闭面板">
							<X />
						</Button>
					</SheetClose>
				</SheetHeader>
				<div className="panel-body">{children}</div>
			</SheetContent>
		</Sheet>
	);
}
