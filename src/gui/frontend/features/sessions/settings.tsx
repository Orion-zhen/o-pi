import { useId, useState } from "react";
import { queueModes, type GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Query } from "../../../shared/protocol/queries.ts";
import type { ConfigCommand } from "@/connection/connection.ts";
import { Switch } from "@/ui/switch.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { Label } from "@/ui/label.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { SourceEditor } from "@/forms/source-editor.tsx";
import { SettingsRow, SettingsSection, SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";

function configError(content: string): string {
	try {
		const value: unknown = JSON.parse(content);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? "" : "设置必须是 JSON 对象。";
	} catch (error) { return error instanceof Error ? error.message : String(error); }
}

type EditorState =
	| { kind: "form"; value?: GuiSnapshot["settings"] }
	| { kind: "loading" }
	| { kind: "file"; view: "source" | "form"; original: string; content: string };

export function AgentSettings({ settings: savedSettings, cacheWarmingModes, send, query, disabled }: {
	settings: GuiSnapshot["settings"]; cacheWarmingModes: GuiSnapshot["cacheWarmingModes"];
	send: ConfigCommand; query: Query; disabled: boolean;
}) {
	const controlId = useId();
	const [editor, setEditor] = useState<EditorState>({ kind: "form" });
	const settings = editor.kind === "form" ? editor.value ?? savedSettings : savedSettings;
	const formDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
	const sourceDirty = editor.kind === "file" && editor.content !== editor.original;
	const sourceError = editor.kind === "file" && sourceDirty ? configError(editor.content) : "";
	const loading = editor.kind === "loading";
	const { saving } = useSettingsState();
	const [error, setError] = useState("");
	useSettingsDraft("agent", {
		title: "会话行为", blocked: disabled,
		plan: !formDirty && !sourceDirty ? { state: "clean" } : sourceError ? { state: "invalid" } : { state: "ready", save: async () => {
			if (editor.kind === "file") await send({ action: "saveConfig", file: "settings.json", original: editor.original, content: editor.content });
			else await send({ action: "settings", ...settings });
			setEditor(editor.kind === "file" && editor.view === "source" ? { ...editor, original: editor.content } : { kind: "form" });
		} },
		discard: () => {
			setEditor(editor.kind === "file" && editor.view === "source" ? { ...editor, content: editor.original } : { kind: "form" });
			setError("");
		},
	});
	const blocked = disabled || saving || sourceDirty || loading;
	const change = (next: GuiSnapshot["settings"]) => {
		setEditor(JSON.stringify(next) === JSON.stringify(savedSettings) ? { kind: "form" } : { kind: "form", value: next });
		setError("");
	};
	const openConfig = async () => {
		if (editor.kind === "file") { setEditor({ ...editor, view: "source" }); return; }
		setEditor({ kind: "loading" }); setError("");
		try {
			const content = await query({ query: "config", file: "settings.json" });
			setEditor({ kind: "file", view: "source", original: content, content });
		} catch (error) {
			setEditor({ kind: "form" });
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const toggles = (items: readonly (readonly ["compaction" | "retry" | "autoResize" | "blockImages", string])[]) =>
		items.map(([key, label]) => <SettingsRow key={key} label={label} htmlFor={`${controlId}-${key}`}>
			<Switch id={`${controlId}-${key}`} aria-label={label} checked={settings[key]} disabled={blocked}
				onCheckedChange={(checked) => change({ ...settings, [key]: checked })} />
		</SettingsRow>);
	return <div className="settings-module">
		{editor.kind === "file" && editor.view === "source" ? <SettingsSection title="会话行为" source actions={<SettingsSourceButton file="settings.json" source disabled={disabled || saving || !!sourceError}
			onClick={() => setEditor(sourceDirty ? { ...editor, view: "form" } : { kind: "form" })} />}>
			<SourceEditor file="settings.json" label="设置 JSON" value={editor.content} disabled={disabled || saving}
				onChange={(content) => { setEditor({ ...editor, content }); setError(""); }} />
			<Feedback message={sourceError} tone="error" />
		</SettingsSection> : <>
			<SettingsSection title="消息队列" actions={<SettingsSourceButton file="settings.json" disabled={loading || disabled || saving || formDirty} onClick={() => void openConfig()} />}>
				<div className="settings-fields">{([["steering", "运行中消息"], ["followUp", "后续消息"]] as const).map(([key, label]) => <SettingsRow key={key} label={label} layout="choice">
					<RadioGroup className="settings-radio-group" orientation="horizontal" aria-label={label} value={settings[key]} disabled={blocked}
						onValueChange={(value) => change({ ...settings, [key]: value as typeof queueModes[number] })}>
						{queueModes.map((mode) => <Label key={mode} className="settings-radio-option"><RadioGroupItem value={mode} />{mode === "one-at-a-time" ? "逐条发送" : "一起发送"}</Label>)}
					</RadioGroup>
				</SettingsRow>)}</div>
			</SettingsSection>
			<SettingsSection title="图片处理"><div className="settings-fields">{toggles([["autoResize", "自动缩放图片"], ["blockImages", "阻止图片发送"]])}</div></SettingsSection>
			<SettingsSection title="会话维护">
				<div className="settings-fields">
				{toggles([["compaction", "自动压缩"], ["retry", "自动重试"]])}
				<SettingsRow label="缓存保温" layout="choice">
					<RadioGroup className="settings-radio-group" orientation="horizontal" aria-label="缓存保温" value={settings.cacheWarming} disabled={blocked}
						onValueChange={(value) => change({ ...settings, cacheWarming: value as GuiSnapshot["settings"]["cacheWarming"] })}>
						{cacheWarmingModes.map((mode) => <Label key={mode} className="settings-radio-option"><RadioGroupItem value={mode} />{mode}</Label>)}
					</RadioGroup>
				</SettingsRow></div>
			</SettingsSection>
		</>}
		<Feedback compact message={error} tone="error" />
	</div>;
}
