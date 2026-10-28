import type { ReactNode } from "react";
import { ScrollArea } from "radix-ui";
import "./list-scroll.css";

export function ListScroll({ children, className = "" }: { children: ReactNode; className?: string }) {
	return <ScrollArea.Root className={`list-scroll ${className}`} type="auto">
		<ScrollArea.Viewport className="list-scroll-viewport" data-list-scroll>{children}</ScrollArea.Viewport>
		<ScrollArea.Scrollbar orientation="vertical" className="list-scroll-track">
			<ScrollArea.Thumb className="list-scroll-thumb" />
		</ScrollArea.Scrollbar>
	</ScrollArea.Root>;
}
