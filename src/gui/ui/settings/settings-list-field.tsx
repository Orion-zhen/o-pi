import { useRef, useState } from "react";
import { ChevronUp, Pencil, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";

export function SettingsListField({ label, value, disabled, change }: {
	label: string; value: readonly unknown[]; disabled: boolean; change: (value: string[]) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const text = value.join("\n");
	const entries = text.split("\n").map((line) => line.trim()).filter(Boolean);
	const action = expanded ? "收起" : entries.length ? "编辑" : "添加";
	return <Collapsible className="settings-list-field" open={expanded} onOpenChange={setExpanded}>
		<div className="settings-list-summary">
			{entries.length ? <>
				<span className="settings-list-preview" title={entries.join("\n")}>{entries.join(" · ")}</span>
				<span className="settings-list-count">{entries.length} 项</span>
			</> : <span className="settings-description">未配置</span>}
			<CollapsibleTrigger asChild><Button ref={trigger} variant="ghost" size="sm" aria-label={`${action}${label}`} disabled={disabled}>
				{expanded ? <ChevronUp aria-hidden="true" /> : entries.length ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}{action}
			</Button></CollapsibleTrigger>
		</div>
		<CollapsibleContent lazy onTransitionEnd={(event) => {
			if (expanded && event.propertyName === "grid-template-rows" && document.activeElement === trigger.current) input.current?.focus();
		}}><div className="settings-list-editor">
			<Textarea ref={input} aria-label={label} placeholder="每行一项" value={text} disabled={disabled}
				onChange={(event) => change(event.target.value === "" ? [] : event.target.value.split("\n"))}
				onBlur={() => { if (JSON.stringify(entries) !== JSON.stringify(value)) change(entries); }} />
		</div></CollapsibleContent>
	</Collapsible>;
}
