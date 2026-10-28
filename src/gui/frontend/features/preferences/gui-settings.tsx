import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Fade } from "@/ui/motion/animated.tsx";
import { settle } from "@/ui/motion/transitions.ts";
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { IconButton } from "@/ui/icon-button.tsx";
import { editPreference, resetSection, sectionChanged, type GuiSection } from "./gui-settings-draft.ts";
import { useGuiSettings } from "./gui-settings-state.tsx";
import type { GuiPreferences } from "../../../shared/config/preferences.ts";
import guiSchema from "../../../../../agent/schemas/gui.schema.json" with { type: "json" };
import { Input } from "@/ui/input.tsx";
import { Switch } from "@/ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group.tsx";
import { AnimatedBackground } from "@/ui/motion/animated-background.tsx";
import { FontPicker } from "./font-picker.tsx";
import { useLocalFonts } from "./use-local-fonts.ts";
import { ThemeColorPicker } from "./theme-color-picker.tsx";
import { MaterialSettings, type MaterialPreferencePath } from "./material-settings.tsx";
import { SourceEditor } from "@/forms/source-editor.tsx";
import { SettingsSection, SettingsRow, SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { SettingsNumber } from "@/forms/number.tsx";
import "./gui-settings.css";

type PreferencePath = MaterialPreferencePath | ["theme"] | ["themeColor"] | ["sendShortcut"] | ["openFileLinksExternally"] | ["preventSleepWhileRunning"] | ["fonts", "ui" | "code"] | ["fontSizes", "ui" | "chat" | "code"] | ["desktopWeb", "enabled" | "host" | "port"];

const themeOptions = [
	{ value: "system", label: "跟随系统", icon: Monitor },
	{ value: "light", label: "浅色", icon: Sun },
	{ value: "dark", label: "深色", icon: Moon },
] as const;

export function GuiSettings({ title, section }: { title: string; section: GuiSection }) {
	const themeHighlightId = useId();
	const shortcutHighlightId = useId();
	const state = useGuiSettings();
	const latest = state?.latest;
	const [theme, setTheme] = useState<GuiPreferences["theme"]>("system");
	// 材质参数跟随已生效主题，避免未保存的主题改变编辑目标。
	if (latest?.state === "ready" && latest.value.theme !== theme) setTheme(latest.value.theme);
	const [editing, setEditing] = useState(false);
	const localFonts = useLocalFonts();
	if (!state) return <SettingsSection title={title}><p role="status">读取中…</p></SettingsSection>;
	const { document, blocked, error, update, changeSource } = state;
	const changed = document.state === "ready" && sectionChanged(document.defaults, document.value, section);
	const actions = <div className="gui-preference-actions">
		<motion.div layout="position" transition={settle} className="settings-heading-actions">
			<SettingsSourceButton file="gui.jsonc" source={editing} disabled={blocked || editing && document.state === "error"} onClick={() => setEditing(!editing)} />
		</motion.div>
		<AnimatePresence initial={false} mode="popLayout" anchorX="right">
			{!editing && document.state === "ready" && changed && <Fade key="reset" className="settings-heading-actions">
				<IconButton size="icon-sm" label={`重置${title}`} tooltip="恢复默认" disabled={blocked}
					onClick={() => update(document, resetSection(document, section))}><RotateCcw /></IconButton>
			</Fade>}
		</AnimatePresence>
	</div>;
	if (editing || document.state === "error") return <div className="settings-module">
		<SettingsSection title={title} actions={actions} source={editing}>
			{editing && <SourceEditor file={document.path} label="GUI 设置 JSONC" value={document.content} disabled={blocked} onChange={(content) => changeSource(content, section)} />}
			{document.state === "error" && <p role="alert">{document.message}</p>}
		</SettingsSection>
		{error && <p role="alert">{error}</p>}
	</div>;
	const change = (path: PreferencePath, value: string | string[] | number | boolean | undefined) => update(document, editPreference(document, path, value));
	return <div className="settings-module">
		{section === "appearance" ? <>
				<SettingsSection title="主题与颜色" actions={actions}><div className="settings-fields">
					<SettingsRow label="主题" reset={{ value: document.value.theme, defaultValue: document.defaults.theme, apply: () => change(["theme"], undefined) }} disabled={blocked}>
						<ToggleGroup type="single" size="sm" className="settings-preference-toggle" aria-label="主题" value={document.value.theme} disabled={blocked}
							onValueChange={(value) => { if (value) change(["theme"], value === document.defaults.theme ? undefined : value); }}>
							{themeOptions.map(({ value, label, icon: Icon }) => <ToggleGroupItem key={value} value={value} className="animated-background-target">
								<AnimatedBackground active={document.value.theme === value} layoutId={themeHighlightId} />
								<Icon aria-hidden="true" />{label}
							</ToggleGroupItem>)}
						</ToggleGroup>
					</SettingsRow>
					<SettingsRow label="主题色" reset={{ value: document.value.themeColor.toUpperCase(), defaultValue: document.defaults.themeColor.toUpperCase(), apply: () => change(["themeColor"], undefined) }} disabled={blocked}>
						<ThemeColorPicker savedValue={state.latest.state === "ready" ? state.latest.value.themeColor : document.defaults.themeColor} value={document.value.themeColor} defaultValue={document.defaults.themeColor} disabled={blocked}
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
								change={(size) => change(["fontSizes", kind], size === document.defaults.fontSizes[kind] ? undefined : size)} />
						</SettingsRow>)}</div>
					<TypographyPreview />
				</SettingsSection>
				<MaterialSettings value={document.value.materials} defaults={document.defaults.materials} theme={theme} disabled={blocked}
					change={change}
					reset={(region, keys) => update(document, keys.reduce((draft, key) => editPreference(draft, ["materials", region, key], undefined), document))} />
			</> : section === "desktopWeb" ? <SettingsSection title="桌面 Web 访问" actions={<><span className="settings-badge">重启生效</span>{actions}</>}>
				<div className="settings-fields">
					<SettingsRow label="Web 访问" reset={{ value: document.value.desktopWeb.enabled, defaultValue: document.defaults.desktopWeb.enabled, apply: () => change(["desktopWeb", "enabled"], undefined) }} disabled={blocked}>
						<Switch aria-label="Web 访问" checked={document.value.desktopWeb.enabled} disabled={blocked}
							onCheckedChange={(value) => change(["desktopWeb", "enabled"], value)} />
					</SettingsRow>
					<SettingsRow label="监听地址" layout="fluid" reset={{ value: document.value.desktopWeb.host, defaultValue: document.defaults.desktopWeb.host, apply: () => change(["desktopWeb", "host"], undefined) }} disabled={blocked}>
						<Input aria-label="监听地址" value={document.value.desktopWeb.host} disabled={blocked || !document.value.desktopWeb.enabled} required pattern="\S+"
							onChange={(event) => change(["desktopWeb", "host"], event.target.value)} />
					</SettingsRow>
					<SettingsRow label="端口（0 自动分配）" reset={{ value: document.value.desktopWeb.port, defaultValue: document.defaults.desktopWeb.port, apply: () => change(["desktopWeb", "port"], undefined) }} disabled={blocked}>
						<SettingsNumber label="监听端口" value={document.value.desktopWeb.port} min={0} max={65535} step={1} disabled={blocked || !document.value.desktopWeb.enabled}
							change={(value) => change(["desktopWeb", "port"], value)} />
					</SettingsRow>
				</div>
				<p className="settings-warning">免登录，勿暴露到公网。</p>
			</SettingsSection> : <SettingsSection title={title} actions={actions}><div className="settings-fields">
				<SettingsRow label="发送快捷键" reset={{ value: document.value.sendShortcut, defaultValue: document.defaults.sendShortcut, apply: () => change(["sendShortcut"], undefined) }} disabled={blocked}>
					<ToggleGroup type="single" size="sm" className="settings-preference-toggle" aria-label="发送快捷键" value={document.value.sendShortcut} disabled={blocked}
						onValueChange={(value) => { if (value) change(["sendShortcut"], value === document.defaults.sendShortcut ? undefined : value); }}>
						{guiSchema.properties.sendShortcut.enum.map((value) => <ToggleGroupItem key={value} value={value} className="animated-background-target">
							<AnimatedBackground active={document.value.sendShortcut === value} layoutId={shortcutHighlightId} />
							{value === "mod-enter" ? `${navigator.userAgent.includes("Macintosh") ? "⌘" : "Ctrl"}+Enter` : "Enter"}
						</ToggleGroupItem>)}
					</ToggleGroup>
				</SettingsRow>
				<SettingsRow label="执行任务时防止空闲睡眠" reset={{ value: document.value.preventSleepWhileRunning, defaultValue: document.defaults.preventSleepWhileRunning, apply: () => change(["preventSleepWhileRunning"], undefined) }} disabled={blocked}>
					<Switch aria-label="执行任务时防止空闲睡眠" checked={document.value.preventSleepWhileRunning} disabled={blocked}
						onCheckedChange={(value) => change(["preventSleepWhileRunning"], value === document.defaults.preventSleepWhileRunning ? undefined : value)} />
				</SettingsRow>
				<SettingsRow label="使用外部应用打开文件链接" reset={{ value: document.value.openFileLinksExternally, defaultValue: document.defaults.openFileLinksExternally, apply: () => change(["openFileLinksExternally"], undefined) }} disabled={blocked}>
					<Switch aria-label="使用外部应用打开文件链接" checked={document.value.openFileLinksExternally} disabled={blocked}
						onCheckedChange={(value) => change(["openFileLinksExternally"], value === document.defaults.openFileLinksExternally ? undefined : value)} />
				</SettingsRow>
			</div></SettingsSection>}
		{error && <p role="alert">{error}</p>}
	</div>;
}

function TypographyPreview() {
	return <div className="typography-preview" aria-label="字体预览">
		<strong>界面文字 Interface</strong><small>辅助信息、时间与状态</small>
		<p>对话正文：你好，世界。Hello, world. 0123456789 → ≠ ✓ 😀</p>
		<pre><code>{'const message = "你好，世界";\nconsole.log(message);'}</code></pre>
	</div>;
}
