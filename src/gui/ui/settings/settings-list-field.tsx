import { useId, useState } from "react";
import { ChevronUp, Pencil, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

export function SettingsListField({ label, value, disabled, change }: {
	label: string; value: readonly unknown[]; disabled: boolean; change: (value: string[]) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const id = useId();
	const text = value.join("\n");
	const entries = text.split("\n").map((line) => line.trim()).filter(Boolean);
	const action = expanded ? "收起" : entries.length ? "编辑" : "添加";
	return <div className="settings-list-field">
		<div className="settings-list-summary">
			{entries.length ? <>
				<span className="settings-list-preview" title={entries.join("\n")}>{entries.join(" · ")}</span>
				<span className="settings-list-count">{entries.length} 项</span>
			</> : <span className="settings-description">未配置</span>}
			<Button variant="ghost" size="sm" aria-label={`${action}${label}`} aria-expanded={expanded} aria-controls={id}
				disabled={disabled} onClick={() => setExpanded(!expanded)}>
				{expanded ? <ChevronUp aria-hidden="true" /> : entries.length ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}{action}
			</Button>
		</div>
		{expanded && <div id={id} className="settings-list-editor">
			<p id={`${id}-hint`} className="settings-description">每行一项，可批量粘贴。修改后需保存。</p>
			<Textarea autoFocus aria-label={label} aria-describedby={`${id}-hint`} value={text} disabled={disabled}
				onChange={(event) => change(event.target.value === "" ? [] : event.target.value.split("\n"))}
				onBlur={() => { if (JSON.stringify(entries) !== JSON.stringify(value)) change(entries); }} />
		</div>}
	</div>;
}
