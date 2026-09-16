import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export function Disclosure({ summary, children, ...props }: ComponentProps<typeof Collapsible> & { summary: ReactNode }) {
	return <Collapsible {...props}>
		<CollapsibleTrigger className="disclosure-trigger"><ChevronRight className="disclosure-chevron" aria-hidden="true" />{summary}</CollapsibleTrigger>
		<CollapsibleContent>{children}</CollapsibleContent>
	</Collapsible>;
}
