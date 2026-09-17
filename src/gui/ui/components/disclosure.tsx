import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export function Disclosure({ summary, children, lazy = false, ...props }: ComponentProps<typeof Collapsible> & { summary: ReactNode; lazy?: boolean }) {
	return <Collapsible {...props}>
		<CollapsibleTrigger className="disclosure-trigger"><ChevronRight className="disclosure-chevron" aria-hidden="true" />{summary}</CollapsibleTrigger>
		<CollapsibleContent lazy={lazy}>{children}</CollapsibleContent>
	</Collapsible>;
}
