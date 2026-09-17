import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { applyEdits, modify } from "jsonc-parser";
import type { GuiConfigDocument } from "../preferences.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { FontPicker } from "./font-picker.tsx";
import { ThemeColorPicker } from "./theme-color-picker.tsx";
import { ConfigEditor } from "./config-editor.tsx";
import "./gui-settings.css";

type PreferencePath = ["theme"] | ["themeColor"] | ["sendShortcut"] | ["fonts", "ui" | "code"] | ["fontSizes", "ui" | "chat" | "code"];

export function GuiSettings({ document, send, disabled, refresh, restoreFocus }: {
	document: GuiConfigDocument | undefined; send: Send; disabled: boolean; refresh: () => Promise<void>; restoreFocus: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState(false);
	useEffect(() => { void refresh(); }, [refresh]);
	if (!document) return <p role="status">正在读取 GUI 设置…</p>;
	const save = async (content: string) => {
		setSaving(true);
		try { return await send({ action: "saveGuiConfig", original: document.content, content }); }
		finally { setSaving(false); }
	};
	const change = (path: PreferencePath, value: string | number | undefined) => {
		const content = document.content || "{}\n";
		return save(applyEdits(content, modify(content, path, value, { formattingOptions: { insertSpaces: false, tabSize: 4 } })));
	};
	const reset = () => {
		let content = document.content || "{}\n";
		for (const key of ["theme", "themeColor", "fonts", "fontSizes", "sendShortcut"])
			content = applyEdits(content, modify(content, [key], undefined, {}));
		void save(content);
	};
	const blocked = disabled || saving;
	return <div className="gui-settings">
		<p className="gui-config-path">配置文件（后端电脑）：<code>{document.path}</code></p>
		{document.state === "error" ? <p role="alert">{document.message}</p> : <>
			<PreferenceRow label="主题" reset={() => change(["theme"], undefined)} disabled={blocked}>
				<NativeSelect aria-label="主题" value={document.value.theme} disabled={blocked} onChange={(event) => change(["theme"], event.target.value === document.defaults.theme ? undefined : event.target.value)}>
					<option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
				</NativeSelect>
			</PreferenceRow>
			<PreferenceRow label="主题色" reset={() => change(["themeColor"], undefined)} disabled={blocked}>
				<ThemeColorPicker value={document.value.themeColor} defaultValue={document.defaults.themeColor} disabled={blocked}
					change={(color) => change(["themeColor"], color === document.defaults.themeColor ? undefined : color)} />
			</PreferenceRow>
			{(["ui", "code"] as const).map((kind) => <PreferenceRow key={kind} label={kind === "ui" ? "界面字体" : "代码字体"} reset={() => change(["fonts", kind], undefined)} disabled={blocked}>
				<FontPicker kind={kind} value={document.value.fonts[kind]} disabled={blocked} onChange={(font) => change(["fonts", kind], font === document.defaults.fonts[kind] ? undefined : font)} />
			</PreferenceRow>)}
			{([ ["ui", "界面字号"], ["chat", "对话字号"], ["code", "代码字号"] ] as const).map(([kind, label]) => <PreferenceRow key={kind} label={label} reset={() => change(["fontSizes", kind], undefined)} disabled={blocked}>
				<FontSize key={document.value.fontSizes[kind]} label={label} value={document.value.fontSizes[kind]} disabled={blocked} change={(size) => change(["fontSizes", kind], size === document.defaults.fontSizes[kind] ? undefined : size)} />
			</PreferenceRow>)}
			<TypographyPreview />
			<PreferenceRow label="发送快捷键" reset={() => change(["sendShortcut"], undefined)} disabled={blocked}>
				<NativeSelect aria-label="发送快捷键" value={document.value.sendShortcut} disabled={blocked} onChange={(event) => change(["sendShortcut"], event.target.value === document.defaults.sendShortcut ? undefined : event.target.value)}>
					<option value="mod-enter">Ctrl / ⌘ + Enter</option><option value="enter">Enter（Shift + Enter 换行）</option>
				</NativeSelect>
			</PreferenceRow>
		</>}
		<div className="toolbar">
			<Button variant="outline" size="sm" disabled={blocked} onClick={() => setEditing(true)}>编辑 gui.jsonc</Button>
			<IconButton label="恢复 GUI 默认设置" disabled={blocked || document.state !== "ready"} onClick={reset}><RotateCcw /></IconButton>
		</div>
		{editing && <ConfigEditor key={document.path} file="gui.jsonc" content={document.content} send={send} close={() => setEditing(false)} restoreFocus={restoreFocus} />}
	</div>;
}

function PreferenceRow({ label, children, reset, disabled }: { label: string; children: React.ReactNode; reset: () => void; disabled: boolean }) {
	return <div className="preference-row"><span>{label}</span>{children}<IconButton label={`重置${label}`} disabled={disabled} onClick={reset}><RotateCcw /></IconButton></div>;
}

function FontSize({ label, value, disabled, change }: { label: string; value: number; disabled: boolean; change: (value: number) => void }) {
	const [draft, setDraft] = useState(String(value));
	return <div className="font-size-control"><Input aria-label={label} type="number" min={8} max={48} step={0.5} value={draft} disabled={disabled}
		onChange={(event) => setDraft(event.target.value)} onBlur={(event) => {
			if (event.target.value && event.target.validity.valid) {
				const next = Number(event.target.value);
				if (next !== value) change(next);
			} else setDraft(String(value));
		}} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>px</span></div>;
}

function TypographyPreview() {
	return <div className="typography-preview" aria-label="字体预览">
		<strong>界面文字 Interface</strong><small>辅助信息、时间与状态</small>
		<p>对话正文：你好，世界。Hello, world.</p>
		<pre><code>{'const message = "你好，世界";\nconsole.log(message);'}</code></pre>
	</div>;
}
