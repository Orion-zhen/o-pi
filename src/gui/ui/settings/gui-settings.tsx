import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { editPreference, resetSection, sectionSave, type GuiSection, type ReadyGuiConfig } from "./gui-settings-draft.ts";
import type { GuiConfigDocument, GuiPreferences } from "../../preferences.ts";
import type { GlobalQuery, Query } from "../../contract.ts";
import type { Send } from "../runtime/connection.ts";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { FontPicker } from "./font-picker.tsx";
import { useLocalFonts } from "./use-local-fonts.ts";
import { ThemeColorPicker } from "./theme-color-picker.tsx";
import { MaterialSettings, type MaterialPreferencePath } from "./material-settings.tsx";
import { ConfigEditor } from "./config-editor.tsx";
import { SettingsSection, SettingsRow, SettingsSourceButton } from "./settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "./settings-state.tsx";
import { SettingsNumber } from "./settings-number.tsx";

type PreferencePath = MaterialPreferencePath | ["theme"] | ["themeColor"] | ["sendShortcut"] | ["fonts", "ui" | "code"] | ["fontSizes", "ui" | "chat" | "code"] | ["desktopWeb", "enabled" | "host" | "port"];

export function GuiSettings({ title, section, document: latest, send, query, disabled, refresh, restoreFocus }: {
	title: string; section: GuiSection;
	document: GuiConfigDocument | undefined; send: Send; query: Query<GlobalQuery>; disabled: boolean; refresh: () => Promise<void>; restoreFocus: () => void;
}) {
	const [theme, setTheme] = useState<GuiPreferences["theme"]>("system");
	// 材质参数跟随已生效主题，避免未保存的主题改变编辑目标。
	if (latest?.state === "ready" && latest.value.theme !== theme) setTheme(latest.value.theme);
	const { saving } = useSettingsState();
	const [editing, setEditing] = useState(false);
	const localFonts = useLocalFonts();
	const [draft, setDraft] = useState<{ base: ReadyGuiConfig; document: ReadyGuiConfig }>();
	const [error, setError] = useState("");
	const dirty = draft !== undefined && draft.document.content !== draft.base.content;
	useSettingsDraft(section, {
		title, dirty, blocked: disabled,
		save: async () => {
			if (!draft) return false;
			setError("");
			// 多个分区共用 gui.jsonc，每次保存都读取前一分区提交后的版本。
			const current = await query({ query: "guiConfig" });
			if (!await send({ action: "saveGuiConfig", ...sectionSave(draft.base, draft.document, current, section) })) {
				setError("保存失败，草稿已保留。");
				return false;
			}
			await refresh();
			setDraft(undefined);
			return true;
		},
		discard: () => { setDraft(undefined); setError(""); },
	});
	const document = draft?.document ?? latest;
	if (!document || !latest) return <SettingsSection title={title}><p role="status">读取中…</p></SettingsSection>;
	const update = (next: ReadyGuiConfig) => {
		if (document.state !== "ready") return;
		const base = draft?.base ?? document;
		setDraft(next.content === base.content ? undefined : { base, document: next });
		setError("");
	};
	const change = async (path: PreferencePath, value: string | string[] | number | boolean | undefined) => {
		if (document.state !== "ready") return false;
		update(editPreference(document, path, value));
		return true;
	};
	const blocked = disabled || saving;
	const actions = <>
		<SettingsSourceButton file="gui.jsonc" disabled={blocked || dirty} onClick={() => setEditing(true)} />
		<IconButton size="icon-sm" label={`重置${title}`} disabled={blocked || document.state !== "ready"}
			onClick={() => { if (document.state === "ready") update(resetSection(document, section)); }}><RotateCcw /></IconButton>
	</>;
	return <div className="settings-module">
		{document.state === "error" ? <SettingsSection title={title} actions={actions}><p role="alert">{document.message}</p></SettingsSection>
			: section === "appearance" ? <>
				<SettingsSection title="主题与颜色" actions={actions}><div className="settings-fields">
					<SettingsRow label="主题" reset={{ value: document.value.theme, defaultValue: document.defaults.theme, apply: () => change(["theme"], undefined) }} disabled={blocked}>
						<Select value={document.value.theme} disabled={blocked} onValueChange={(value) => void change(["theme"], value === document.defaults.theme ? undefined : value)}>
							<SelectTrigger aria-label="主题"><SelectValue /></SelectTrigger>
							<SelectContent><SelectItem value="system">跟随系统</SelectItem><SelectItem value="light">浅色</SelectItem><SelectItem value="dark">深色</SelectItem></SelectContent>
						</Select>
					</SettingsRow>
					<SettingsRow label="主题色" reset={{ value: document.value.themeColor.toUpperCase(), defaultValue: document.defaults.themeColor.toUpperCase(), apply: () => change(["themeColor"], undefined) }} disabled={blocked}>
						<ThemeColorPicker savedValue={latest.state === "ready" ? latest.value.themeColor : document.defaults.themeColor} value={document.value.themeColor} defaultValue={document.defaults.themeColor} disabled={blocked}
							change={(color) => change(["themeColor"], color === document.defaults.themeColor ? undefined : color)} />
					</SettingsRow>
				</div></SettingsSection>
				<SettingsSection title="字体与字号">
					<div className="settings-fields">{(["ui", "code"] as const).map((kind) => <SettingsRow key={kind} label={kind === "ui" ? "界面字体" : "代码字体"} layout="fluid"
						reset={{ value: document.value.fonts[kind], defaultValue: document.defaults.fonts[kind], apply: () => change(["fonts", kind], undefined) }} disabled={blocked}>
						<FontPicker kind={kind} value={document.value.fonts[kind]} disabled={blocked} local={localFonts}
							onChange={(fonts) => change(["fonts", kind], fonts.length === 0 ? undefined : fonts)} />
					</SettingsRow>)}
					{([["ui", "界面字号"], ["chat", "对话字号"], ["code", "代码字号"]] as const).map(([kind, label]) =>
						<SettingsRow key={kind} label={label} reset={{ value: document.value.fontSizes[kind], defaultValue: document.defaults.fontSizes[kind], apply: () => change(["fontSizes", kind], undefined) }} disabled={blocked}>
							<SettingsNumber label={label} value={document.value.fontSizes[kind]} min={8} max={48} step={0.5} unit="px" disabled={blocked}
								change={(size) => void change(["fontSizes", kind], size === document.defaults.fontSizes[kind] ? undefined : size)} />
						</SettingsRow>)}</div>
					<TypographyPreview />
				</SettingsSection>
				<MaterialSettings value={document.value.materials} defaults={document.defaults.materials} theme={theme} disabled={blocked}
					change={(path, value) => void change(path, value)}
					reset={(region, keys) => update(keys.reduce((draft, key) => editPreference(draft, ["materials", region, key], undefined), document))} />
			</> : section === "desktopWeb" ? <SettingsSection title="桌面 Web 访问" actions={<><span className="settings-badge">重启生效</span>{actions}</>}>
				<div className="settings-fields">
					<SettingsRow label="Web 访问" reset={{ value: document.value.desktopWeb.enabled, defaultValue: document.defaults.desktopWeb.enabled, apply: () => change(["desktopWeb", "enabled"], undefined) }} disabled={blocked}>
						<Switch aria-label="Web 访问" checked={document.value.desktopWeb.enabled} disabled={blocked}
							onCheckedChange={(value) => void change(["desktopWeb", "enabled"], value)} />
					</SettingsRow>
					<SettingsRow label="监听地址" layout="fluid" reset={{ value: document.value.desktopWeb.host, defaultValue: document.defaults.desktopWeb.host, apply: () => change(["desktopWeb", "host"], undefined) }} disabled={blocked}>
						<Input aria-label="监听地址" value={document.value.desktopWeb.host} disabled={blocked || !document.value.desktopWeb.enabled} required pattern="\S+"
							onChange={(event) => void change(["desktopWeb", "host"], event.target.value)} />
					</SettingsRow>
					<SettingsRow label="端口（0 自动分配）" reset={{ value: document.value.desktopWeb.port, defaultValue: document.defaults.desktopWeb.port, apply: () => change(["desktopWeb", "port"], undefined) }} disabled={blocked}>
						<SettingsNumber label="监听端口" value={document.value.desktopWeb.port} min={0} max={65535} step={1} disabled={blocked || !document.value.desktopWeb.enabled}
							change={(value) => void change(["desktopWeb", "port"], value)} />
					</SettingsRow>
				</div>
				<p className="settings-warning">免登录，勿暴露到公网。</p>
			</SettingsSection> : <SettingsSection title="发送方式" actions={actions}><div className="settings-fields">
				<SettingsRow label="发送快捷键" reset={{ value: document.value.sendShortcut, defaultValue: document.defaults.sendShortcut, apply: () => change(["sendShortcut"], undefined) }} disabled={blocked}>
					<Select value={document.value.sendShortcut} disabled={blocked} onValueChange={(value) => void change(["sendShortcut"], value === document.defaults.sendShortcut ? undefined : value)}>
						<SelectTrigger aria-label="发送快捷键"><SelectValue /></SelectTrigger>
						<SelectContent><SelectItem value="mod-enter">Ctrl / ⌘ + Enter</SelectItem><SelectItem value="enter">Enter</SelectItem></SelectContent>
					</Select>
				</SettingsRow>
			</div></SettingsSection>}
		{error && <p role="alert">{error}</p>}
		{editing && <ConfigEditor key={document.path} file="gui.jsonc" content={document.content} send={send} close={() => { setEditing(false); void refresh(); }} restoreFocus={restoreFocus} />}
	</div>;
}

function TypographyPreview() {
	return <div className="typography-preview" aria-label="字体预览">
		<strong>界面文字 Interface</strong><small>辅助信息、时间与状态</small>
		<p>对话正文：你好，世界。Hello, world. 0123456789 → ≠ ✓ 😀</p>
		<pre><code>{'const message = "你好，世界";\nconsole.log(message);'}</code></pre>
	</div>;
}
