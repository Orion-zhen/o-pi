import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence } from "motion/react";
import { Fade, Reveal } from "./components/animated";
import { Notices } from "./notices";
import {
	ArrowDown,
	ArrowUpRight,
	Code2,
	ExternalLink,
	FolderSearch,
	LoaderCircle,
	PanelLeft,
	PanelRight,
	RefreshCw,
	ShieldCheck,
	Terminal,
	X,
} from "lucide-react";
import { pretty, safeLink } from "./content.tsx";
import { locateTranscript } from "./transcript-location.ts";
import { Transcript } from "./transcript.tsx";
import { useTranscriptScroll } from "./use-transcript-scroll.ts";
import { Dialog } from "./dialog.tsx";
import { Panel } from "./panels.tsx";
import { PanelDialog } from "./components/panel-dialog";
import { Settings } from "./settings-panel.tsx";
import { connectionLabels } from "./connection.ts";
import { Composer } from "./composer.tsx";
import { Sidebar } from "./sidebar.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";
import { SessionActions } from "./session-actions.tsx";
import { SessionHistory } from "./session-history.tsx";
import { SessionHeading } from "./session-heading.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { useGui } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { ResizeHandle } from "./components/resize-handle";
import { Button } from "./components/ui/button";
import { Sheet, SheetTrigger } from "./components/ui/sheet";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyThemeColor } from "./theme/apply.ts";
import { DEFAULT_THEME_COLOR } from "./theme/palette.ts";
import "./theme.css";
import "./style.css";
import "./transcript.css";
import "./tools.css";
import "./rich-tools.css";
import "./code.css";
import "./motion.css";
import "./layout.css";

const starters = [
	{ icon: FolderSearch, title: "了解项目", text: "梳理这个项目的结构，介绍主要模块和运行方式。" },
	{ icon: Code2, title: "审查代码", text: "审查当前工作区的代码变更，指出潜在问题和改进建议。" },
	{ icon: Terminal, title: "开始构建", text: "我想实现一个新功能，请先了解项目并和我讨论实现方案。" },
];

function App() {
	const gui = useGui();
	const { snapshot, dialogs, notices, status, error, panel, auth, send } = gui;
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const transcript = useTranscriptScroll(snapshot?.sessionId);
	const [location, setLocation] = useState<{ sessionId: string; entryId: string }>();
	const target = location?.sessionId === snapshot?.sessionId ? location?.entryId : undefined;
	const located = snapshot ? locateTranscript(snapshot, target) : undefined;
	useLayoutEffect(() => { if (target) transcript.toEntry(target); }, [location]);
	const panelContent = useRef<HTMLDivElement>(null);
	const main = useRef<HTMLElement>(null);
	const app = useRef<HTMLDivElement>(null);
	const workspace = useRef<HTMLDivElement>(null);
	const restoreFocus = () => (panelContent.current ?? gui.editor.current ?? main.current)?.focus();
	useEffect(() => {
		const desktop = window.matchMedia("(min-width: 768px)");
		const closeMobileSidebar = (event: MediaQueryListEvent) => {
			if (event.matches) setMobileOpen(false);
		};
		desktop.addEventListener("change", closeMobileSidebar);
		return () => desktop.removeEventListener("change", closeMobileSidebar);
	}, []);
	const authUrl =
		auth?.type === "auth_url" ? auth.url : auth?.type === "device_code" ? auth.verificationUri : undefined;
	const state = !gui.connected ? connectionLabels[status] : dialogs.length ? "等待操作" : gui.running ? "运行中" : "就绪";
	return (
		<TooltipProvider delayDuration={350}>
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<div className="app" data-collapsed={collapsed} ref={app} style={gui.layout.style}>
					<Sidebar
						gui={gui}
						collapsed={collapsed}
						toggle={() => setCollapsed(!collapsed)}
						close={() => setMobileOpen(false)}
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
								{gui.running ? (
									<LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
								) : (
									<span className="status-dot" />
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
										gui.editor.current?.focus();
									}
									else gui.setSessionPanelOpen(true);
								}}
							><PanelRight /></IconButton>
						</header>
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
									<IconButton label="收起登录提示" onClick={() => gui.setAuth(undefined)}>
										<X />
									</IconButton>
								</div>
								<pre>{pretty(auth)}</pre>
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
						<div className="transcript" ref={transcript.scroll} onScroll={transcript.onScroll} onClickCapture={transcript.onClickCapture} onWheel={transcript.onWheel} onTouchStart={transcript.onTouchStart} onPointerDown={transcript.onPointerDown} onKeyDown={transcript.onKeyDown}>
							<div className="transcript-content" ref={transcript.content}>
								<AnimatePresence initial={false} mode="wait">
								{!snapshot && (
									<Fade key="workspace-welcome" className="welcome workspace-welcome">
										<div className="welcome-mark">
											<FolderSearch aria-hidden="true" />
										</div>
										<h1>选择工作区</h1>
										<p>打开项目目录，或从侧栏恢复历史会话。</p>
										<WorkspacePicker gui={gui} close={() => setMobileOpen(false)} />
									</Fade>
								)}
								{snapshot && !snapshot.messages.length && !located?.preview && (
									<Fade key={`welcome-${snapshot.sessionId}`} className="welcome">
										<div className="welcome-mark">
											<Terminal aria-hidden="true" />
										</div>
										<p className="welcome-eyebrow">你的代码工作空间</p>
										<h1>今天，想构建什么？</h1>
										<p>从一个想法开始，一起把它变成现实。</p>
										<div className="starter-grid">
											{starters.map(({ icon: Icon, title, text }) => (
												<Button
													key={title}
													variant="outline"
													className="starter"
													onClick={() => {
														gui.setDraft(text);
														gui.editor.current?.focus();
													}}
												>
													<Icon />
													<span>{title}</span>
													<ArrowUpRight />
												</Button>
											))}
										</div>
										{!snapshot.model && (
											<Button variant="ghost" size="sm" onClick={() => gui.setPanel({ kind: "auth" })}>
												<ShieldCheck />
												配置模型认证
											</Button>
										)}
									</Fade>
								)}
								{snapshot && located && (snapshot.messages.length > 0 || located.preview) && <Fade className="flex min-w-0 flex-col" key={located.preview ? `${snapshot.sessionId}:${target}` : snapshot.sessionId}
									onAnimationComplete={() => { if (target) transcript.toEntry(target); }}>
									{located.preview && <div className="toolbar" role="status">正在只读预览历史分支或已压缩消息<Button variant="outline" onClick={() => { setLocation(undefined); requestAnimationFrame(transcript.followLatest); }}>返回当前会话</Button></div>}
									<Transcript source={located.source} entryIds={located.entryIds} />
								</Fade>}
								</AnimatePresence>
								<AnimatePresence initial={false}>{snapshot?.status["bash"] && <Reveal><pre className="live-output">{snapshot.status["bash"]}</pre></Reveal>}</AnimatePresence>
								<Notices notices={notices} />
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
						{transcript.showLatest && <Fade className="jump-latest-region"><Button variant="outline" size="sm" className="jump-latest" onClick={transcript.toLatest}>
							<ArrowDown />回到最新
						</Button></Fade>}
						</AnimatePresence>
						</div>
						{snapshot && <Composer gui={gui} snapshot={snapshot} onSubmit={transcript.followLatest} />}
					</main>
					<ResizeHandle label="调整右侧栏宽度" className="info-resize" value={gui.layout.values.right} change={(value, persist) => gui.layout.set("right", value, persist)} measure={() => {
						const sidebar = workspace.current?.querySelector<HTMLElement>(".session-sidebar");
						const available = workspace.current?.clientWidth ?? 0;
						const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
						const min = Math.min(12 * rem, available * 0.4);
						return { value: sidebar?.getBoundingClientRect().width ?? 0, min, max: Math.max(min, available - Math.min(20 * rem, available * 0.45) - 8), scale: -1 };
					}} />
					{snapshot && <SessionSidebar gui={gui} locate={(entryId) => setLocation({ sessionId: snapshot.sessionId, entryId })} />}
					</div>
				</div>
			</Sheet>
			<AnimatePresence mode="wait">
			{panel?.kind === "settings" ? <PanelDialog key="settings" ref={panelContent} title="设置" close={() => gui.setPanel(undefined)} restoreFocus={restoreFocus}>
				<Settings snapshot={snapshot} guiConfig={gui.guiConfig} send={send} query={gui.query} disabled={!gui.canChangeSession} connected={gui.connected} refreshGuiConfig={gui.refreshGuiConfig} restoreFocus={restoreFocus} />
			</PanelDialog> : panel && snapshot && (
				<Panel key={panel.kind}
					ref={panelContent}
					restoreFocus={restoreFocus}
					panel={panel}
					snapshot={snapshot}
					sessionList={<SessionHistory gui={gui} close={() => gui.setPanel(undefined)} full />}
					send={send}
					canChangeSession={gui.canChangeSession}
					close={() => gui.setPanel(undefined)}
				/>
			)}
			</AnimatePresence>
			<AnimatePresence mode="wait">
			{dialogs[0] && <Dialog restoreFocus={restoreFocus} key={dialogs[0].id} dialog={dialogs[0]} send={send} />}
			</AnimatePresence>
		</TooltipProvider>
	);
}

applyThemeColor(DEFAULT_THEME_COLOR);
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
