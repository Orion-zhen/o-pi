import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { editPreference, resetSection, sectionSave, type GuiSection, type ReadyGuiConfig } from "./gui-settings-draft.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { FontPicker } from "./font-picker.tsx";
import { useLocalFonts } from "./use-local-fonts.ts";
import { ThemeColorPicker } from "./theme-color-picker.tsx";
import { ConfigEditor } from "./config-editor.tsx";
import "./gui-settings.css";

type PreferencePath = ["theme"] | ["themeColor"] | ["sendShortcut"] | ["fonts", "ui" | "code"] | ["fontSizes", "ui" | "chat" | "code"] | ["desktopWeb", "enabled" | "host" | "port"];

export function GuiSettings({ section, document: latest, send, disabled, refresh, restoreFocus, onDirty }: {
	section: GuiSection;
	document: GuiConfigDocument | undefined; send: Send; disabled: boolean; refresh: () => Promise<void>; restoreFocus: () => void;
	onDirty: (id: GuiSection, dirty: boolean) => void;
}) {
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState(false);
	const localFonts = useLocalFonts();
	const [draft, setDraft] = useState<{ base: ReadyGuiConfig; document: ReadyGuiConfig }>();
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const dirty = draft !== undefined && draft.document.content !== draft.base.content;
	useEffect(() => { onDirty(section, dirty); }, [section, dirty, onDirty]);
	useEffect(() => () => onDirty(section, false), [section, onDirty]);
	const document = draft?.document ?? latest;
	if (!document || !latest) return <p role="status">正在读取 GUI 设置…</p>;
	const update = (next: ReadyGuiConfig) => {
		if (document.state !== "ready") return;
		const base = draft?.base ?? document;
		setDraft(next.content === base.content ? undefined : { base, document: next });
		setStatus("");
	};
	const save = async () => {
		if (!draft) return;
		setSaving(true); setError(""); setStatus("");
		try {
			if (await send({ action: "saveGuiConfig", ...sectionSave(draft.base, draft.document, latest, section) })) {
				await refresh();
				setDraft(undefined);
				setStatus("已保存");
			} else setError("保存失败，请查看错误通知。草稿已保留。");
		} finally { setSaving(false); }
	};
	const change = async (path: PreferencePath, value: string | string[] | number | boolean | undefined) => {
		if (document.state !== "ready") return false;
		update(editPreference(document, path, value));
		return true;
	};
	const reset = () => {
		if (document.state === "ready") update(resetSection(document, section));
	};
	const blocked = disabled || saving;
	return <div className="gui-settings module-settings">
		{document.state === "error" ? <p role="alert">{document.message}</p> : <>
			{section === "appearance" ? <>
			<PreferenceRow label="主题" reset={() => change(["theme"], undefined)} disabled={blocked}>
				<Select value={document.value.theme} disabled={blocked} onValueChange={(value) => void change(["theme"], value === document.defaults.theme ? undefined : value)}>
					<SelectTrigger aria-label="主题"><SelectValue /></SelectTrigger>
					<SelectContent><SelectItem value="system">跟随系统</SelectItem><SelectItem value="light">浅色</SelectItem><SelectItem value="dark">深色</SelectItem></SelectContent>
				</Select>
			</PreferenceRow>
			<PreferenceRow label="主题色" reset={() => change(["themeColor"], undefined)} disabled={blocked}>
				<ThemeColorPicker savedValue={latest.state === "ready" ? latest.value.themeColor : document.defaults.themeColor} value={document.value.themeColor} defaultValue={document.defaults.themeColor} disabled={blocked}
					change={(color) => change(["themeColor"], color === document.defaults.themeColor ? undefined : color)} />
			</PreferenceRow>
			{(["ui", "code"] as const).map((kind) => <PreferenceRow key={kind} label={kind === "ui" ? "界面字体" : "代码字体"} reset={() => change(["fonts", kind], undefined)} disabled={blocked}>
				<FontPicker kind={kind} value={document.value.fonts[kind]} disabled={blocked} local={localFonts}
					onChange={(fonts) => change(["fonts", kind], fonts.length === 0 ? undefined : fonts)} />
			</PreferenceRow>)}
			{([ ["ui", "界面字号"], ["chat", "对话字号"], ["code", "代码字号"] ] as const).map(([kind, label]) => <PreferenceRow key={kind} label={label} reset={() => change(["fontSizes", kind], undefined)} disabled={blocked}>
				<FontSize label={label} value={document.value.fontSizes[kind]} disabled={blocked} change={(size) => change(["fontSizes", kind], size === document.defaults.fontSizes[kind] ? undefined : size)} />
			</PreferenceRow>)}
			<TypographyPreview />
			</> : section === "desktopWeb" ? <>
				<p className="settings-warning">默认关闭。保存后需重启 Desktop，不影响独立的 opi-web。退出 Desktop 会停止 Web 服务和后台任务。</p>
				<p className="settings-warning">免登录，能连接此端口的设备可操作后端文件和进程。建议保留 127.0.0.1 并通过 SSH 隧道访问，勿直接暴露到公网。</p>
				<PreferenceRow label="启用 Web 访问" reset={() => change(["desktopWeb", "enabled"], undefined)} disabled={blocked}>
					<Checkbox aria-label="启用 Web 访问" checked={document.value.desktopWeb.enabled} disabled={blocked}
						onCheckedChange={(value) => void change(["desktopWeb", "enabled"], value === true)} />
				</PreferenceRow>
				<PreferenceRow label="监听地址" reset={() => change(["desktopWeb", "host"], undefined)} disabled={blocked}>
					<WebAddressField label="监听地址" value={document.value.desktopWeb.host} disabled={blocked}
						change={(value) => change(["desktopWeb", "host"], value)} />
				</PreferenceRow>
				<PreferenceRow label="监听端口" reset={() => change(["desktopWeb", "port"], undefined)} disabled={blocked}>
					<WebAddressField label="监听端口" value={document.value.desktopWeb.port} disabled={blocked}
						change={(value) => change(["desktopWeb", "port"], value)} />
				</PreferenceRow>
				<p className="settings-warning">端口范围 0–65535，0 表示自动分配。实际监听地址输出到 Desktop 启动日志。</p>
			</> : <PreferenceRow label="发送快捷键" reset={() => change(["sendShortcut"], undefined)} disabled={blocked}>
				<Select value={document.value.sendShortcut} disabled={blocked} onValueChange={(value) => void change(["sendShortcut"], value === document.defaults.sendShortcut ? undefined : value)}>
					<SelectTrigger aria-label="发送快捷键"><SelectValue /></SelectTrigger>
					<SelectContent><SelectItem value="mod-enter">Ctrl / ⌘ + Enter</SelectItem><SelectItem value="enter">Enter（Shift + Enter 换行）</SelectItem></SelectContent>
				</Select>
			</PreferenceRow>}
		</>}
		<div className="toolbar">
			<Button variant="outline" size="sm" disabled={blocked || dirty} onClick={() => setEditing(true)}>编辑 gui.jsonc</Button>
			<IconButton label="恢复本页默认设置" disabled={blocked || document.state !== "ready"} onClick={reset}><RotateCcw /></IconButton>
		</div>
		{error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
		<div className="toolbar module-actions">
			<Button disabled={blocked || !dirty} onClick={() => void save()}>保存</Button>
			<Button variant="outline" disabled={blocked || !dirty} onClick={() => { setDraft(undefined); setError(""); setStatus(""); }}>放弃修改</Button>
			<Button variant="ghost" disabled={blocked || dirty} onClick={() => { setDraft(undefined); setError(""); setStatus(""); void refresh(); }}>重新读取</Button>
			{dirty && <span role="status">有未保存修改</span>}
		</div>
		{editing && <ConfigEditor key={document.path} file="gui.jsonc" content={document.content} send={send} close={() => setEditing(false)} restoreFocus={restoreFocus} />}
	</div>;
}

function PreferenceRow({ label, children, reset, disabled }: { label: string; children: React.ReactNode; reset: () => void; disabled: boolean }) {
	return <div className="preference-row"><span>{label}</span>{children}<IconButton label={`重置${label}`} disabled={disabled} onClick={reset}><RotateCcw /></IconButton></div>;
}

function FontSize({ label, value, disabled, change }: { label: string; value: number; disabled: boolean; change: (value: number) => void }) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return <div className="font-size-control"><Input aria-label={label} type="number" min={8} max={48} step={0.5} value={draft} disabled={disabled}
		onChange={(event) => {
			setDraft(event.target.value);
			if (event.target.value && event.target.validity.valid) change(Number(event.target.value));
		}} onBlur={() => setDraft(String(value))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>px</span></div>;
}

function WebAddressField({ label, value, disabled, change }: {
	label: string; value: string | number; disabled: boolean; change: (value: string | number) => void;
}) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	const numeric = typeof value === "number";
	return <Input aria-label={label} type={numeric ? "number" : "text"} required
		min={numeric ? 0 : undefined} max={numeric ? 65535 : undefined} step={numeric ? 1 : undefined}
		pattern={numeric ? undefined : "\\S+"} value={text} disabled={disabled} onChange={(event) => {
			setText(event.target.value);
			if (event.target.validity.valid) change(numeric ? Number(event.target.value) : event.target.value);
		}}
		onBlur={(event) => {
			event.target.reportValidity();
			setText(String(value));
		}} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function TypographyPreview() {
	return <div className="typography-preview" aria-label="字体预览">
		<strong>界面文字 Interface</strong><small>辅助信息、时间与状态</small>
		<p>对话正文：你好，世界。Hello, world. 0123456789 → ≠ ✓ 😀</p>
		<pre><code>{'const message = "你好，世界";\nconsole.log(message);'}</code></pre>
	</div>;
}
