import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	ArrowDown,
	ArrowUpRight,
	Code2,
	ExternalLink,
	FolderSearch,
	LoaderCircle,
	PanelLeft,
	RefreshCw,
	ShieldCheck,
	Terminal,
	X,
} from "lucide-react";
import { clean, pretty, safeLink } from "./content.tsx";
import { Transcript } from "./transcript.tsx";
import { useTranscriptScroll } from "./use-transcript-scroll.ts";
import { Dialog } from "./dialog.tsx";
import { ConfigEditor, Panel } from "./panels.tsx";
import { Composer } from "./composer.tsx";
import { Sidebar } from "./sidebar.tsx";
import { SessionHistory } from "./session-history.tsx";
import { SessionHeading } from "./session-heading.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { useGui } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Sheet, SheetTrigger } from "./components/ui/sheet";
import { TooltipProvider } from "./components/ui/tooltip";
import "./theme.css";
import "./style.css";
import "./transcript.css";
import "./tools.css";
import "./rich-tools.css";
import "./code.css";

const starters = [
	{ icon: FolderSearch, title: "了解项目", text: "梳理这个项目的结构，介绍主要模块和运行方式。" },
	{ icon: Code2, title: "审查代码", text: "审查当前工作区的代码变更，指出潜在问题和改进建议。" },
	{ icon: Terminal, title: "开始构建", text: "我想实现一个新功能，请先了解项目并和我讨论实现方案。" },
];

function App() {
	const gui = useGui();
	const { snapshot, dialogs, notices, status, error, panel, config, auth, send } = gui;
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const transcript = useTranscriptScroll(snapshot?.sessionId);
	const panelContent = useRef<HTMLDivElement>(null);
	const main = useRef<HTMLElement>(null);
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
	const state = status !== "已连接" ? status : dialogs.length ? "等待操作" : gui.running ? "运行中" : "就绪";
	return (
		<TooltipProvider delayDuration={350}>
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<div className="app" data-collapsed={collapsed}>
					<Sidebar
						gui={gui}
						collapsed={collapsed}
						toggle={() => setCollapsed(!collapsed)}
						close={() => setMobileOpen(false)}
					/>
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
							{status !== "已连接" && (
								<IconButton label="重新连接" onClick={gui.reconnect}>
									<RefreshCw />
								</IconButton>
							)}
						</header>
						{error && (
							<div role="alert" className="error-banner">
								<pre>{error}</pre>
								<IconButton label="关闭错误提示" onClick={() => gui.setError("")}>
									<X />
								</IconButton>
							</div>
						)}
						{auth && (
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
						)}
						<div className="transcript-shell">
						<div className="transcript" ref={transcript.scroll} onScroll={transcript.onScroll} onClickCapture={transcript.onClickCapture}>
							<div className="transcript-content" ref={transcript.content}>
								{!snapshot && (
									<section className="welcome workspace-welcome">
										<div className="welcome-mark">
											<FolderSearch aria-hidden="true" />
										</div>
										<h1>选择工作区</h1>
										<p>打开项目目录，或从侧栏恢复历史会话。</p>
										<WorkspacePicker gui={gui} close={() => setMobileOpen(false)} />
									</section>
								)}
								{snapshot && !snapshot.messages.length && (
									<section className="welcome">
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
										{snapshot && !snapshot.model && (
											<Button variant="ghost" size="sm" onClick={() => gui.command("/login")}>
												<ShieldCheck />
												配置模型认证
											</Button>
										)}
									</section>
								)}
								{snapshot && <Transcript key={snapshot.sessionId} source={snapshot} />}
								{snapshot?.status["bash"] && <pre className="live-output">{snapshot.status["bash"]}</pre>}
								{notices.length > 0 && (
									<details className="notices" open={notices.some((notice) => notice.type === "error")}>
										<summary>通知 ({notices.length})</summary>
										{notices.map((notice) => (
											<pre className={notice.type} key={notice.id}>
												{clean(notice.text)}
											</pre>
										))}
									</details>
								)}
							</div>
						</div>
						{transcript.showLatest && <Button variant="outline" size="sm" className="jump-latest" onClick={transcript.toLatest}>
							<ArrowDown />回到最新
						</Button>}
						</div>
						{snapshot && <Composer gui={gui} onSubmit={transcript.toLatest} />}
					</main>
				</div>
			</Sheet>
			{panel && snapshot && (
				<Panel
					ref={panelContent}
					restoreFocus={restoreFocus}
					panel={panel}
					snapshot={snapshot}
					sessionList={<SessionHistory gui={gui} close={() => gui.setPanel(undefined)} full />}
					send={send}
					close={() => gui.setPanel(undefined)}
				/>
			)}
			{config && (
				<ConfigEditor
					restoreFocus={restoreFocus}
					file={config.file}
					content={config.content}
					send={send}
					close={() => gui.setConfig(undefined)}
				/>
			)}
			{dialogs[0] && <Dialog restoreFocus={restoreFocus} key={dialogs[0].id} dialog={dialogs[0]} send={send} />}
		</TooltipProvider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
