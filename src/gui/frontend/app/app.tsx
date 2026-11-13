import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { LoaderCircle } from "lucide";
import { MorphIcon } from "morphicons/react";
import { StatusDot } from "@/ui/icon-shapes.ts";
import { Crossfade, Fade, Reveal } from "@/ui/motion/animated.tsx";
import { FeedbackHighlight } from "@/ui/feedback-highlight.tsx";
import { ConversationContent } from "./conversation-content.tsx";
import { RegionBoundary } from "@/diagnostics/region-boundary.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { NotificationErrorContext, Notifications } from "@/ui/notifications.tsx";
import {
	ArrowDown,
	Ellipsis,
	PanelLeft,
	PanelRight,
	RefreshCw,
} from "lucide-react";
import { AuthBanner } from "@/features/auth/auth-banner.tsx";
import { hasContextMessages, isTranscriptPreview } from "@/features/chat/transcript/transcript-location.ts";
import { useTranscriptScroll } from "@/features/chat/transcript/use-transcript-scroll.ts";
import { Dialog } from "./dialog.tsx";
import { Panel } from "./panels.tsx";
import { SettingsDialog } from "./settings/dialog.tsx";
import { connectionLabels } from "@/connection/connection.ts";
import { Composer } from "@/features/chat/composer/composer.tsx";
import { Sidebar } from "./sidebar.tsx";
import { SessionInspector } from "./session-inspector.tsx";
import { SessionActions } from "@/features/sessions/session-actions.tsx";
import { SessionHistory } from "@/features/sessions/session-history.tsx";
import { SessionHeading } from "@/features/sessions/session-heading.tsx";
import { useGui } from "./use-gui.ts";
import { useStartupMotion } from "./welcome/use-startup-motion.ts";
import { StartupEntranceContext, type StartupRegion } from "./welcome/startup-entrance.tsx";
import { isTouchInput } from "@/ui/input-mode.ts";
import { GuiQueryContext } from "@/connection/query-context.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { Button } from "@/ui/button.tsx";
import { Sheet, SheetTrigger } from "@/ui/sheet.tsx";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import { ImagePreviewProvider } from "@/ui/media/image-preview.tsx";

/** 条件持续满足 delay 毫秒后才转真，避免正常启动时闪现工作区欢迎页。 */
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
	const gui = useGui();
	const { session, navigation, editor, panels, connection, config, auth } = gui;
	const { status } = connection;
	const { panel } = panels;
	const snapshot = session?.snapshot ?? null;
	const dialog = session?.dialogs[0];
	const dialogCount = session?.dialogs.length ?? 0;
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const toggleSidebar = useCallback(() => setCollapsed((value) => !value), []);
	const closeSidebar = useCallback(() => setMobileOpen(false), []);
	const transcript = useTranscriptScroll(snapshot?.sessionId, session?.view);
	useLayoutEffect(() => { if (gui.changelog.changelog) transcript.readFromStart(); }, [gui.changelog.changelog]);
	const [location, setLocation] = useState<{ sessionId: string; entryId: string }>();
	useEffect(() => setLocation(undefined), [session?.target.id ?? null]);
	const sessionId = snapshot?.sessionId;
	const workspaceWelcome = useDelayed(!snapshot, 500);
	const locate = useCallback((entryId: string) => { if (sessionId) setLocation({ sessionId, entryId }); }, [sessionId]);
	const target = location?.sessionId === snapshot?.sessionId ? location?.entryId : undefined;
	const preview = snapshot ? isTranscriptPreview(snapshot, target) : false;
	const completedAt = navigation.activity.find((item) => item.sessionId === sessionId)?.completedAt ?? 0;
	useEffect(() => {
		const check = () => {
			if (sessionId && !snapshot?.running && !preview && dialogCount === 0 && document.visibilityState === "visible" && document.hasFocus() && transcript.atLatest())
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
	}, [sessionId, snapshot?.running, preview, dialogCount, completedAt, gui.markRead, transcript.showLatest]);
	useLayoutEffect(() => { transcript.restorePosition(); if (target) transcript.toEntry(target); }, [location, sessionId]);
	const panelContent = useRef<HTMLDivElement>(null);
	const main = useRef<HTMLElement>(null);
	const app = useRef<HTMLDivElement>(null);
	const workspace = useRef<HTMLDivElement>(null);
	const showWelcome = useMemo(() => snapshot ? !preview && !hasContextMessages(snapshot) : workspaceWelcome,
		[snapshot?.entries, snapshot?.contextEntryIds, preview, workspaceWelcome]);
	const startup = useStartupMotion(showWelcome, Boolean(snapshot));
	const [entrances] = useState(() => new Set<StartupRegion>());
	const restoreFocus = () => (panelContent.current ?? (isTouchInput() ? null : editor.input.current) ?? main.current)?.focus();
	useEffect(() => {
		const desktop = window.matchMedia("(min-width: 768px)");
		const closeMobileSidebar = (event: MediaQueryListEvent) => {
			if (event.matches) setMobileOpen(false);
		};
		desktop.addEventListener("change", closeMobileSidebar);
		return () => desktop.removeEventListener("change", closeMobileSidebar);
	}, []);
	const state = !connection.connected ? connectionLabels[status] : dialogCount ? "等待操作" : snapshot?.compacting ? "正在压缩上下文" : snapshot?.running ? "运行中" : "就绪";
	const active = state === "运行中" || state === "正在压缩上下文";
	return (
		<NotificationErrorContext value={gui.notifications.reportError}><GuiQueryContext value={config.query}><TooltipProvider delayDuration={350}>
			<ImagePreviewProvider sessionId={session?.target.id ?? null} fallbackFocus={main}><StartupEntranceContext value={entrances}>
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<div className="app" data-collapsed={collapsed} ref={app} style={navigation.layout.style}>
					<RegionBoundary scope="sidebar"><Sidebar
						gui={navigation}
						collapsed={collapsed}
						toggle={toggleSidebar}
						close={closeSidebar}
					/></RegionBoundary>
					<ResizeHandle label="调整左侧栏宽度" className="sidebar-resize" value={navigation.layout.values.left} change={(value, persist) => navigation.layout.set("left", value, persist)} measure={() => {
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
					<main className="main-panel" ref={main} tabIndex={-1} {...startup.interaction}>
						<RegionBoundary scope="toolbar"><header className="topbar">
							<SheetTrigger asChild>
								<IconButton className="mobile-menu" label="菜单">
									<PanelLeft />
								</IconButton>
							</SheetTrigger>
							{snapshot ? (
								<SessionHeading key={snapshot.sessionId} name={snapshot.name} titleGeneration={snapshot.titleGeneration} send={config.send} />
							) : (
								<div className="session-heading"><strong className="session-name">选择工作区</strong></div>
							)}
							<div role="status" className="connection-status" data-state={state}>
								<MorphIcon icon={active ? LoaderCircle : StatusDot} spring="smooth" size="1em" className={active ? "animate-spin" : undefined} />
								<Crossfade value={state}>{state}</Crossfade>
							</div>
							{!connection.connected && (
								<IconButton label="重新连接" onClick={connection.reconnect}>
									<RefreshCw />
								</IconButton>
							)}
							{session ? <SessionActions key={`actions:${session.target.id}`} workspace={navigation} send={session.send} canSubmit={navigation.canSubmit}
								canCopySession={gui.canCopySession} setPanel={panels.setPanel} notifications={gui.notifications} />
								: <IconButton label="会话操作" disabled><Ellipsis /></IconButton>}
							<IconButton
								label={panels.sessionPanelOpen ? "收起会话信息" : "展开会话信息"}
								aria-expanded={panels.sessionPanelOpen}
								disabled={!navigation.canSubmit}
								onClick={() => {
									if (panels.sessionPanelOpen) {
										panels.setSessionPanelOpen(false);
										restoreFocus();
									}
									else panels.setSessionPanelOpen(true);
								}}
							><PanelRight /></IconButton>
						</header></RegionBoundary>
						<div className="conversation-canvas">
						<AnimatePresence initial={false}>
						<Feedback message={config.document?.state === "error" ? `界面配置无法加载：${config.document.message}` : ""} tone="error" variant="banner">
							<Button variant="ghost" size="sm" onClick={() => panels.setPanel({ kind: "settings" })}>打开设置</Button>
						</Feedback>
						{auth.auth && session && <Reveal key="auth"><AuthBanner auth={auth.auth} url={auth.authUrl} deviceCode={auth.deviceCode} send={session.send} error={auth.error} onError={auth.setError} /></Reveal>}
						</AnimatePresence>
						<div className="transcript-shell">
						<div className="transcript" ref={transcript.scroll} onScroll={transcript.onScroll} onClickCapture={transcript.onClickCapture} onWheel={transcript.onWheel} onTouchStart={transcript.onTouchStart} onPointerDown={transcript.onPointerDown} onKeyDown={transcript.onKeyDown}>
							<div className="transcript-content" ref={transcript.content} key={snapshot?.sessionId ?? "loading"}>
								{transcript.highlight && <FeedbackHighlight key={transcript.highlight.key} style={transcript.highlight.bounds} />}
								<RegionBoundary scope="messages">
									<ConversationContent session={session} navigation={navigation} editor={editor} config={config} panels={panels} availableVersion={gui.availableVersion} changelog={gui.changelog} target={target} showWelcome={showWelcome} startup={startup} closeSidebar={closeSidebar}
										clearLocation={() => setLocation(undefined)} transcript={transcript} />
								</RegionBoundary>
							</div>
						</div>
						<div className="conversation-resize-track" aria-label="对话宽度调整" onPointerMove={(event) => {
							const track = event.currentTarget;
							track.style.setProperty("--resize-y", `${event.clientY - track.getBoundingClientRect().top}px`);
						}}>
							{(["left", "right"] as const).map((edge) => <ResizeHandle key={edge} label={`调整对话宽度（${edge === "left" ? "左" : "右"}边缘）`} value={navigation.layout.values.conversation}
								change={(value, persist) => navigation.layout.set("conversation", value, persist)} measure={() => {
									const max = transcript.scroll.current?.clientWidth ?? 0;
									return { value: transcript.content.current?.getBoundingClientRect().width ?? 0, min: max * 0.4, max, scale: edge === "left" ? -2 : 2 };
								}} />)}
						</div>
						<AnimatePresence initial={false}>
						{transcript.showLatest && <Fade className="jump-latest-region"><Button variant="outline" size="sm" className="jump-latest floating-surface" onClick={() => { if (!preview) setLocation(undefined); transcript.toLatest(); }}>
							<ArrowDown />回到最新
						</Button></Fade>}
						</AnimatePresence>
						</div>
						{session?.state === "ready" && <RegionBoundary scope="composer" key={session.target.id}><Composer {...startup.composer}
							gui={{ connected: connection.connected, canSubmit: navigation.canSubmit, workspaceMissing: navigation.workspaceMissing, setPanel: panels.setPanel, editor: editor.input, views: editor.views }}
							session={session} preferences={config.document?.state === "ready" ? config.document.value : undefined} onSubmit={transcript.followLatest} referenceVersion={editor.referenceVersion} /></RegionBoundary>}
						</div>
						<Notifications items={gui.notifications.items} dismiss={gui.notifications.dismiss}
							suspended={Boolean(panel) || Boolean(dialog) || mobileOpen} />
					</main>
					<ResizeHandle label="调整右侧栏宽度" className="info-resize" value={navigation.layout.values.right} change={(value, persist) => navigation.layout.set("right", value, persist)} measure={() => {
						const sidebar = workspace.current?.querySelector<HTMLElement>(".session-sidebar");
						const available = workspace.current?.clientWidth ?? 0;
						const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
						const min = Math.min(12 * rem, available * 0.4);
						return { value: sidebar?.getBoundingClientRect().width ?? 0, min, max: Math.max(min, available - Math.min(20 * rem, available * 0.45) - 8), scale: -1 };
					}} />
					<aside className="session-sidebar" aria-label="会话信息" data-open={panels.sessionPanelOpen} inert={!panels.sessionPanelOpen} aria-hidden={!panels.sessionPanelOpen}>
						{navigation.cwd && <RegionBoundary scope="session-sidebar" key={snapshot?.sessionId}><SessionInspector session={session} panels={panels} workspace={navigation} locate={locate} /></RegionBoundary>}
					</aside>
					</div>
				</div>
			</Sheet>
			<AnimatePresence mode="wait">
			{panel?.kind === "settings" ? <RegionBoundary scope="settings" inline={false} key="settings" onFailure={panels.closePanel}>
				<SettingsDialog ref={panelContent} close={panels.closePanel} initialCategory={panel.category} snapshot={snapshot} guiConfig={config.document} dispatch={config.send} query={config.query} globalQuery={navigation.globalQuery} disabled={!navigation.canChangeSession} connected={connection.connected} refreshGuiConfig={config.refresh} restoreFocus={restoreFocus} />
			</RegionBoundary> : panel && session?.state === "ready" && (
				<RegionBoundary scope="panel" inline={false} key={`${session.target.id}:${panel.kind}`} onFailure={panels.closePanel}><Panel
					ref={panelContent}
					restoreFocus={restoreFocus}
					panel={panel}
					snapshot={session.snapshot}
					sessionList={<SessionHistory cwd={navigation.cwd} sessionRows={navigation.sessionRows} sessions={navigation.sessions} sessionsLoading={navigation.sessionsLoading}
						refreshSessions={navigation.refreshSessions} send={navigation.globalSend} connected={connection.connected} close={panels.closePanel} full />}
					send={config.send}
					canSubmit={navigation.canSubmit}
					close={panels.closePanel}
				/></RegionBoundary>
			)}
			</AnimatePresence>
			<AnimatePresence mode="wait">
			{session && dialog && <RegionBoundary scope="dialog" inline={false} key={dialog.id}><Dialog restoreFocus={restoreFocus} dialog={dialog} send={session.send} /></RegionBoundary>}
			</AnimatePresence>
			</StartupEntranceContext></ImagePreviewProvider>
		</TooltipProvider></GuiQueryContext></NotificationErrorContext>
	);
}
