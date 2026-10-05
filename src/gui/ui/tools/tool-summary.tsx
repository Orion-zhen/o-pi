import { ChevronRight } from "lucide-react";
import { outputPreview } from "../../messages.ts";
import { toolFacts } from "../../tool-facts.ts";
import { Hint } from "../components/ui/tooltip";
import { CollapsibleTrigger } from "../components/ui/collapsible";
import { ActivityState, toolDisplay } from "./tool-display.tsx";
import { toolTarget } from "./tool-target.ts";
import type { ToolActivity } from "../transcript/transcript-items.ts";

export function ToolSummary({ tool, open, stateLabel }: { tool: ToolActivity; open: boolean; stateLabel?: string }) {
	const { label, icon: Icon } = toolDisplay(tool.name);
	const target = toolTarget(tool.name, tool.args);
	const facts = tool.output?.kind === "reference" ? tool.output.facts : toolFacts({ ...tool, output: outputPreview(tool.output) });
	return <Hint content={tool.name}><CollapsibleTrigger className="activity-summary" data-tool-name={tool.name}>
		<Icon className="activity-icon" aria-hidden="true" />
		<span className="activity-label">{label}</span>
		<code className="activity-target">{target}</code>
		{facts && <span className="activity-facts">{facts}</span>}
		<ActivityState state={tool.state} label={stateLabel} />
		<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
	</CollapsibleTrigger></Hint>;
}
