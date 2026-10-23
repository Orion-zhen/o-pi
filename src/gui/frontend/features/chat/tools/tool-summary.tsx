import { ChevronRight } from "lucide-react";
import { outputPreview } from "../../../../shared/messages/output.ts";
import { toolFacts } from "../../../../shared/messages/tool-facts.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { ActivityState, toolDisplay } from "./tool-display.tsx";
import { toolTarget } from "./tool-target.ts";
import type { ToolActivity } from "./activity.ts";

export function ToolSummary({ tool, open, stateLabel }: { tool: ToolActivity; open: boolean; stateLabel?: string }) {
	const { label, icon: Icon } = toolDisplay(tool.name);
	const target = toolTarget(tool.name, tool.args);
	const facts = tool.output?.kind === "reference" ? tool.output.facts : toolFacts({ ...tool, output: outputPreview(tool.output) });
	return <Hint content={tool.name}><CollapsibleTrigger className="activity-summary" data-tool-name={tool.name}>
		<Icon className="activity-icon" aria-hidden="true" />
		<span className="activity-label">{label}</span>
		<code className="activity-target">{target}</code>
		<span className="activity-tail">
			<ActivityState state={tool.state} label={stateLabel} facts={facts} durationMs={tool.durationMs} />
			<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
		</span>
	</CollapsibleTrigger></Hint>;
}
