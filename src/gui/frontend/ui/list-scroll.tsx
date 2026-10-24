import { useReducer, type ReactNode } from "react";
import { ScrollArea } from "radix-ui";
import "./list-scroll.css";

export function ListScroll({ children, className = "" }: { children: ReactNode | ((refresh: () => void) => ReactNode); className?: string }) {
	const [revision, refresh] = useReducer((value: number) => value + 1, 0);
	return <ScrollArea.Root className={`list-scroll ${className}`} type="auto">
		<ScrollArea.Viewport className="list-scroll-viewport" data-list-scroll>{typeof children === "function" ? children(refresh) : children}</ScrollArea.Viewport>
		<ScrollArea.Scrollbar key={revision} orientation="vertical" className="list-scroll-track">
			<ScrollArea.Thumb className="list-scroll-thumb" />
		</ScrollArea.Scrollbar>
	</ScrollArea.Root>;
}
