import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Fade, Reveal } from "../components/animated";
import { NoticeGroupView, groupNotices } from "./notices";
import {
	ArrowDown,
	ExternalLink,
	LoaderCircle,
	PanelLeft,
	PanelRight,
	RefreshCw,
	ShieldCheck,
	X,
} from "lucide-react";
import { safeLink } from "../content/content.tsx";
import { locateTranscript } from "../transcript/transcript-location.ts";
import { Transcript } from "../transcript/transcript.tsx";
import type { TranscriptSource } from "../transcript/transcript-items.ts";
import { DisclosureMemoryContext } from "../components/disclosure-memory.ts";
import { useTranscriptScroll } from "../transcript/use-transcript-scroll.ts";
import { Dialog } from "./dialog.tsx";
import { Panel } from "./panels.tsx";
import { PanelDialog } from "../components/panel-dialog";
import { Settings } from "../settings/settings-panel.tsx";
import { connectionLabels } from "../runtime/connection.ts";
import { Composer } from "../composer/composer.tsx";
import { Sidebar } from "./sidebar.tsx";
import { SessionSidebar } from "../sessions/session-sidebar.tsx";
import { SessionActions } from "../sessions/session-actions.tsx";
import { SessionHistory } from "../sessions/session-history.tsx";
import { SessionHeading } from "../sessions/session-heading.tsx";
import { WorkspacePicker } from "../workspace/workspace-picker.tsx";
import { Welcome } from "./welcome/welcome.tsx";
import { WelcomeSurface } from "./welcome/welcome-surface.tsx";
import { StartupChangelog } from "./welcome/startup-changelog.tsx";
import { useGui } from "./use-gui.ts";
import { useStartupMotion } from "./welcome/use-startup-motion.ts";
import { useActivityAnimations } from "./use-activity-animations.ts";
import { isTouchInput } from "../lib/input-mode.ts";
import { GuiQueryContext } from "../runtime/payload.tsx";
import { IconButton } from "../components/icon-button";
import { ResizeHandle } from "../components/resize-handle";
import { Button } from "../components/ui/button";
import { Dialog as ConfirmDialog, DialogContent, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { Sheet, SheetTrigger } from "../components/ui/sheet";
import { TooltipProvider } from "../components/ui/tooltip";

/** 条件持续满足 delay 毫秒后才转真; 正常启动时会话先于超时到达, 工作区欢迎页不再闪现. */
function useDelayed(value: boolean, delay: number): boolean {
	const [delayed, setDelayed] = useState(false);
	useEffect(() => {
		if (!value) { setDelayed(false); return; }
		const timer = setTimeout(() => setDelayed(true), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return delayed;
}

export function App() {
	useActivityAnimations();
	const gui = useGui();
	const { snapshot, dialogs, notices, status, error, panel, auth, authUrl, deviceCode, send } = gui;
	const [mobileOpen, setMobileOpen] = useState(false);
	const [settingsDirty, setSettingsDirty] = useState(false);
	const [confirmSettingsClose, setConfirmSettingsClose] = useState(false);
	useEffect(() => {
		if (!settingsDirty) return;
		const preventClose = (event: BeforeUnloadEvent) => { event.preventDefault(); };
		window.addEventListener("beforeunload", preventClose);
		return () => window.removeEventListener("beforeunload", preventClose);
	}, [settingsDirty]);
	const [collapsed, setCollapsed] = useState(false);
	const toggleSidebar = useCallback(() => setCollapsed((value) => !value), []);
	const closeSidebar = useCallback(() => setMobileOpen(false), []);
	const transcript = useTranscriptScroll(snapshot?.sessionId, gui.view);
	useLayoutEffect(() => { if (gui.changelog) transcript.readFromStart(); }, [gui.changelog]);
	const [location, setLocation] = useState<{ sessionId: string; entryId: string }>();
	useEffect(() => setLocation(undefined), [gui.selectedId]);
	const sessionId = snapshot?.sessionId;
	const workspaceWelcome = useDelayed(!snapshot, 500);
	const locate = useCallback((entryId: string) => { if (sessionId) setLocation({ sessionId, entryId }); }, [sessionId]);
	const target = location?.sessionId === snapshot?.sessionId ? location?.entryId : undefined;
	const located = useMemo(() => snapshot ? locateTranscript(snapshot, target) : undefined, [snapshot?.entries, snapshot?.contextEntryIds, snapshot?.leafId, target]);
	const source = useMemo<TranscriptSource | undefined>(() => snapshot && located ? {
		...snapshot, messages: located.messages,
		...(located.preview ? { streamingMessage: null, liveTools: [], streaming: false, retrying: false } : {}),
	} : undefined, [snapshot, located]);
	const memory = gui.view?.disclosures;
	const completedAt = gui.activity.find((item) => item.sessionId === sessionId)?.completedAt ?? 0;
	useEffect(() => {
		const check = () => {
			if (sessionId && !snapshot?.running && !located?.preview && dialogs.length === 0 && document.visibilityState === "visible" && document.hasFocus() && transcript.atLatest())
				gui.markRead(sessionId, completedAt);
		};
		const frame = requestAnimationFrame(check);
		const viewport = transcript.scroll.current;
		viewport?.addEventListener("scroll", check);
		window.addEventListener("focus", check);
		document.addEventListener("visibilitychange", check);
		return () => {
			cancelAnimationFrame(frame);
			viewport?.removeEventListener("scroll", check);
			window.removeEventListener("focus", check);
			document.removeEventListener("visibilitychange", check);
		};
	}, [sessionId, snapshot?.running, located?.preview, dialogs.length, completedAt, gui.markRead, transcript.showLatest]);
	const noticeGroups = useMemo(() => groupNotices(notices), [notices]);
	const inlineGroups = useMemo(() => located?.preview ? [] : noticeGroups, [located?.preview, noticeGroups]);
	const noticeTail = snapshot ? snapshot.messages.length + (snapshot.streamingMessage ? 1 : 0) : 0;
	const clearNoticeGroup = useCallback((ids: string[]) => { void send({ action: "clearNotices", ids }); }, [send]);
	const inlineNotices = Boolean(snapshot && located && !located.preview && snapshot.messages.length > 0);
	useLayoutEffect(() => { transcript.restorePosition(); if (target) transcript.toEntry(target); }, [location, sessionId]);
	const panelContent = useRef<HTMLDivElement>(null);
	const main = useRef<HTMLElement>(null);
	const app = useRef<HTMLDivElement>(null);
	const workspace = useRef<HTMLDivElement>(null);
	useStartupMotion(app, Boolean(snapshot));
	const restoreFocus = () => (panelContent.current ?? (isTouchInput() ? null : gui.editor.current) ?? main.current)?.focus();
	useEffect(() => {
		const desktop = window.matchMedia("(min-width: 768px)");
		const closeMobileSidebar = (event: MediaQueryListEvent) => {
			if (event.matches) setMobileOpen(false);
		};
		desktop.addEventListener("change", closeMobileSidebar);
		return () => desktop.removeEventListener("change", closeMobileSidebar);
	}, []);
	const state = !gui.connected ? connectionLabels[status] : dialogs.length ? "等待操作" : gui.running ? "运行中" : "就绪";
	return (
		<GuiQueryContext value={gui.query}><TooltipProvider delayDuration={350}>
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<div className="app" data-collapsed={collapsed} ref={app} style={gui.layout.style}>
					<Sidebar
						gui={gui.sidebar}
						collapsed={collapsed}
						toggle={toggleSidebar}
						close={closeSidebar}
					/>
					<ResizeHandle label="调整左侧栏宽度" className="sidebar-resize" value={gui.layout.values.left} change={(value, persist) => gui.layout.set("left", value, persist)} measure={() => {
						const sidebar = app.current?.querySelector<HTMLElement>(".sidebar");
						const available = app.current?.clientWidth ?? 0;
						const right = workspace.current?.querySelector<HTMLElement>('.session-sidebar[data-open="true"]');
						const beside = window.matchMedia("(min-width: 64.001em)").matches;
						const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
						const min = Math.min(8 * rem, available * 0.25);
						const mainMin = Math.min(20 * rem, (workspace.current?.clientWidth ?? available) * 0.45);
						return { value: sidebar?.getBoundingClientRect().width ?? 0, min, max: Math.max(min, available - mainMin - (beside ? right?.getBoundingClientRect().width ?? 0 : 0) - 16) };
					}} />
					<div className="chat-workspace" ref={workspace}>
					<main className="main-panel" ref={main} tabIndex={-1}>
						<header className="topbar">
							<SheetTrigger asChild>
								<IconButton className="mobile-menu" label="菜单">
									<PanelLeft />
								</IconButton>
							</SheetTrigger>
							{snapshot ? (
								<SessionHeading key={snapshot.sessionId} name={snapshot.name} send={send} />
							) : (
								<div className="session-heading"><strong className="session-name">选择工作区</strong></div>
							)}
							<div role="status" className="connection-status" data-state={state}>
								{state === "运行中" ? (
									<LoaderCircle className="animate-spin" aria-hidden="true" />
								) : (
									<span className="status-dot" aria-hidden="true" />
								)}
								<span>{state}</span>
							</div>
							{!gui.connected && (
								<IconButton label="重新连接" onClick={gui.reconnect}>
									<RefreshCw />
								</IconButton>
							)}
							<SessionActions gui={gui} />
							<IconButton
								label={gui.sessionPanelOpen ? "收起会话信息" : "展开会话信息"}
								aria-expanded={gui.sessionPanelOpen}
								disabled={!gui.canSubmit}
								onClick={() => {
									if (gui.sessionPanelOpen) {
										gui.setSessionPanelOpen(false);
										restoreFocus();
									}
									else gui.setSessionPanelOpen(true);
								}}
							><PanelRight /></IconButton>
						</header>
						<div className="conversation-canvas">
						<AnimatePresence initial={false}>
						{gui.guiConfig?.state === "error" && <Reveal key="gui-config-error"><div role="alert" className="error-banner">GUI 配置无效：{gui.guiConfig.message}<Button variant="outline" onClick={() => gui.setPanel({ kind: "settings" })}>打开设置</Button></div></Reveal>}
						{error && <Reveal key="error">
							<div role="alert" className="error-banner">
								<pre>{error}</pre>
								<IconButton label="关闭错误提示" onClick={() => gui.setError("")}>
									<X />
								</IconButton>
							</div>
						</Reveal>}
						{auth && <Reveal key="auth">
							<div className="auth-banner">
								<div className="flex items-center justify-between">
									<span className="flex items-center gap-2">
										<ShieldCheck className="size-4" />
										模型认证
									</span>
								</div>
								{authUrl && <p>请在认证页面完成登录，完成后会自动继续。未打开页面？点击下方按钮。</p>}
								{deviceCode && <p>在认证页面输入设备码：<strong>{deviceCode}</strong></p>}
								{(auth.type === "progress" || auth.type === "info") && <p role="status">{auth.message}</p>}
								{auth.type === "info" && auth.links?.filter((link) => safeLink(link.url)).map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label ?? link.url}</a>)}
								{authUrl && !window.opi && <p className="text-sm text-muted-foreground">远程连接时，本地回调可能无法到达后端；请使用提供方支持的设备码登录。</p>}
								<div className="toolbar">
									{authUrl && safeLink(authUrl) && (
										<Button variant="outline" size="sm" asChild>
											<a
												href={authUrl}
												target="_blank"
												rel="noreferrer"
												onClick={(event) => {
													if (window.opi) {
														event.preventDefault();
														void window.opi
															.openExternal(authUrl)
															.catch((error: unknown) => gui.setError(String(error)));
													}
												}}
											>
												<ExternalLink />
												打开认证页面
											</a>
										</Button>
									)}
									<Button variant="ghost" size="sm" onClick={() => void send({ action: "cancelLogin" })}>
										取消登录
									</Button>
								</div>
							</div>
						</Reveal>}
						</AnimatePresence>
						<div className="transcript-shell">
						<div className="transcript" data-list-scroll ref={transcript.scroll} onScroll={transcript.onScroll} onClickCapture={transcript.onClickCapture} onWheel={transcript.onWheel} onTouchStart={transcript.onTouchStart} onPointerDown={transcript.onPointerDown} onKeyDown={transcript.onKeyDown}>
							<div className="transcript-content" ref={transcript.content} key={snapshot?.sessionId ?? "loading"}>
								{snapshot && gui.availableVersion && !located?.preview && <div className="startup-version" role="status">Pi v{gui.availableVersion} 版本可用</div>}
								{snapshot && gui.changelog && !located?.preview && <StartupChangelog value={gui.changelog} shown={gui.changelogShown} />}
								<AnimatePresence initial={false} mode="wait" presenceAffectsLayout={false}>
								{workspaceWelcome && (
									<Fade key="workspace-welcome" initial={false} className="welcome workspace-welcome">
										<WelcomeSurface>
											<div className="welcome-mark">
												<span className="app-logo" role="img" aria-label="opi" />
											</div>
											<h1>选择工作区</h1>
											<p>打开项目目录，或从侧栏恢复历史会话。</p>
											<WorkspacePicker gui={gui} close={() => setMobileOpen(false)} />
										</WelcomeSurface>
									</Fade>
								)}
								{snapshot && !snapshot.messages.length && !located?.preview && (
									<Fade key={`welcome-${snapshot.sessionId}`} initial={false} className="welcome">
										<WelcomeSurface><Welcome snapshot={snapshot} gui={gui} /></WelcomeSurface>
									</Fade>
								)}
								{snapshot && located && source && (snapshot.messages.length > 0 || located.preview) && <Fade className="flex min-w-0 flex-col" key={located.preview ? `${snapshot.sessionId}:${target}` : snapshot.sessionId}
									onAnimationComplete={() => { if (target) transcript.toEntry(target); }}>
									{located.preview && <div className="toolbar" role="status">正在只读预览历史分支或已压缩消息<Button variant="outline" onClick={() => { setLocation(undefined); requestAnimationFrame(transcript.followLatest); }}>返回当前会话</Button></div>}
									<DisclosureMemoryContext value={memory}><Transcript source={source} entryIds={located.entryIds}
										prunedToolCallIds={located.prunedToolCallIds} groups={inlineGroups} tail={noticeTail} clear={clearNoticeGroup} windowRef={transcript.virtualizer} target={target} view={located.preview ? undefined : gui.view} /></DisclosureMemoryContext>
								</Fade>}
								</AnimatePresence>
								<AnimatePresence initial={false}>{snapshot?.bashOutput && <Reveal><pre className="live-output">{snapshot.bashOutput}</pre></Reveal>}</AnimatePresence>
								<AnimatePresence initial={false}>{!inlineNotices && noticeGroups.map((group) =>
									<NoticeGroupView key={group.anchor} group={group} live={group.anchor >= noticeTail} clear={clearNoticeGroup} />)}</AnimatePresence>
							</div>
						</div>
						<div className="conversation-resize-track" aria-label="对话宽度调整" onPointerMove={(event) => {
							const track = event.currentTarget;
							track.style.setProperty("--resize-y", `${event.clientY - track.getBoundingClientRect().top}px`);
						}}>
							{(["left", "right"] as const).map((edge) => <ResizeHandle key={edge} label={`调整对话宽度（${edge === "left" ? "左" : "右"}边缘）`} value={gui.layout.values.conversation}
								change={(value, persist) => gui.layout.set("conversation", value, persist)} measure={() => {
									const max = transcript.scroll.current?.clientWidth ?? 0;
									return { value: transcript.content.current?.getBoundingClientRect().width ?? 0, min: Math.min(320, max), max, scale: edge === "left" ? -2 : 2 };
								}} />)}
						</div>
						<AnimatePresence initial={false}>
						{transcript.showLatest && <Fade className="jump-latest-region"><Button variant="outline" size="sm" className="jump-latest floating-surface" onClick={() => { if (!located?.preview) setLocation(undefined); transcript.toLatest(); }}>
							<ArrowDown />回到最新
						</Button></Fade>}
						</AnimatePresence>
						</div>
						{snapshot && gui.view && <Composer key={snapshot.sessionId} gui={gui} view={gui.view} snapshot={snapshot} preferences={gui.guiConfig?.state === "ready" ? gui.guiConfig.value : undefined} onSubmit={transcript.followLatest} />}
						</div>
					</main>
					<ResizeHandle label="调整右侧栏宽度" className="info-resize" value={gui.layout.values.right} change={(value, persist) => gui.layout.set("right", value, persist)} measure={() => {
						const sidebar = workspace.current?.querySelector<HTMLElement>(".session-sidebar");
						const available = workspace.current?.clientWidth ?? 0;
						const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
						const min = Math.min(12 * rem, available * 0.4);
						return { value: sidebar?.getBoundingClientRect().width ?? 0, min, max: Math.max(min, available - Math.min(20 * rem, available * 0.45) - 8), scale: -1 };
					}} />
					{gui.cwd && <SessionSidebar gui={gui} locate={locate} />}
					</div>
				</div>
			</Sheet>
			<AnimatePresence mode="wait">
			{panel?.kind === "settings" ? <PanelDialog key="settings" ref={panelContent} title="设置" close={() => settingsDirty ? setConfirmSettingsClose(true) : gui.setPanel(undefined)} restoreFocus={restoreFocus}>
				<Settings initialCategory={panel.category} onDirty={setSettingsDirty} snapshot={snapshot} guiConfig={gui.guiConfig} send={send} query={gui.query} globalQuery={gui.globalQuery} disabled={!gui.canChangeSession} connected={gui.connected} refreshGuiConfig={gui.refreshGuiConfig} restoreFocus={restoreFocus} />
			</PanelDialog> : panel && snapshot && (
				<Panel key={panel.kind}
					ref={panelContent}
					restoreFocus={restoreFocus}
					panel={panel}
					snapshot={snapshot}
					sessionList={<SessionHistory cwd={gui.cwd} sessionRows={gui.sessionRows} sessions={gui.sessions} sessionsLoading={gui.sessionsLoading}
						refreshSessions={gui.refreshSessions} send={gui.send} canNavigate={gui.canNavigate} connected={gui.connected} close={gui.closePanel} full />}
					send={send}
					canChangeSession={gui.canChangeSession}
					close={() => gui.setPanel(undefined)}
				/>
			)}
			</AnimatePresence>
			{confirmSettingsClose && <ConfirmDialog open onOpenChange={setConfirmSettingsClose}>
				<DialogContent><DialogTitle>放弃未保存的设置？</DialogTitle>
					<DialogDescription>各分类中的未保存修改都会丢失。</DialogDescription>
					<div className="toolbar"><Button variant="outline" onClick={() => setConfirmSettingsClose(false)}>继续编辑</Button>
						<Button variant="destructive" onClick={() => { setConfirmSettingsClose(false); setSettingsDirty(false); gui.setPanel(undefined); }}>放弃并关闭</Button></div>
				</DialogContent>
			</ConfirmDialog>}
			<AnimatePresence mode="wait">
			{dialogs[0] && <Dialog restoreFocus={restoreFocus} key={dialogs[0].id} dialog={dialogs[0]} send={send} />}
			</AnimatePresence>
		</TooltipProvider></GuiQueryContext>
	);
}
