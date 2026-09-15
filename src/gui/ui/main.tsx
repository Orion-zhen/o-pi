import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Content, Message, clean, pretty, safeLink } from "./content.tsx";
import { Dialog } from "./dialog.tsx";
import { ConfigEditor, Panel } from "./panels.tsx";
import { Composer } from "./composer.tsx";
import { Sidebar } from "./sidebar.tsx";
import { useGui } from "./use-gui.ts";
import "./style.css";

function App() {
	const gui = useGui();
	const { snapshot, dialogs, notices, status, error, panel, config, auth, send } = gui;
	const [sidebar, setSidebar] = useState(false);
	const scroll = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	useEffect(() => {
		if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [snapshot]);
	const authUrl =
		auth?.type === "auth_url" ? auth.url : auth?.type === "device_code" ? auth.verificationUri : undefined;
	return (
		<div className="app">
			<Sidebar gui={gui} visible={sidebar} close={() => setSidebar(false)} />
			<main>
				<header className="topbar">
					<button className="mobile-menu" onClick={() => setSidebar(!sidebar)}>
						菜单
					</button>
					<div>
						<strong>{snapshot?.name ?? "正在启动 SDK"}</strong>
						<small>{snapshot?.cwd}</small>
					</div>
					<span className={dialogs.length ? "waiting" : ""}>
						{dialogs.length ? "等待操作" : gui.running ? "运行中" : "就绪"}
					</span>
				</header>
				<div className="connection-status">
					{status}
					{status !== "已连接" && <button onClick={gui.reconnect}>重新连接</button>}
				</div>
				{error && (
					<div role="alert" className="error-banner">
						<pre>{error}</pre>
						<button onClick={() => gui.setError("")}>关闭</button>
					</div>
				)}
				{auth && (
					<div className="auth-banner">
						<button onClick={() => gui.setAuth(undefined)}>收起登录提示</button>
						<pre>{pretty(auth)}</pre>
						{authUrl && safeLink(authUrl) && (
							<a
								href={authUrl}
								target="_blank"
								rel="noreferrer"
								onClick={(event) => {
									if (window.opi) {
										event.preventDefault();
										void window.opi.openExternal(authUrl).catch((error: unknown) => gui.setError(String(error)));
									}
								}}
							>
								打开认证页面
							</a>
						)}
						<button onClick={() => void send({ action: "cancelLogin" })}>取消登录</button>
					</div>
				)}
				<div
					className="transcript"
					ref={scroll}
					onScroll={() => {
						if (scroll.current)
							follow.current =
								scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100;
					}}
				>
					{!snapshot?.messages.length && (
						<section className="welcome">
							<h2>开始一个真实会话</h2>
							<p>选择工作目录和模型，输入任务。工具在后端电脑上执行。</p>
							<button onClick={() => gui.command("/login")}>配置模型认证</button>
						</section>
					)}
					{snapshot?.messages.map((message, index) => (
						<Message key={`${snapshot.sessionId}-${index}`} value={message} />
					))}
					{snapshot?.streamingMessage && <Message value={snapshot.streamingMessage} streaming />}
					{snapshot?.liveTools.map((event) => (
						<details className="tool" open key={event.toolCallId}>
							<summary>执行中: {event.toolName}</summary>
							{event.type === "tool_execution_update" ? (
								<Content value={event.partialResult.content} />
							) : (
								<pre>{pretty(event.args)}</pre>
							)}
						</details>
					))}
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
				<Composer
					gui={gui}
					onSubmit={() => {
						follow.current = true;
					}}
				/>
			</main>
			{panel && snapshot && (
				<Panel panel={panel} snapshot={snapshot} send={send} close={() => gui.setPanel(undefined)} />
			)}
			{config && (
				<ConfigEditor file={config.file} content={config.content} send={send} close={() => gui.setConfig(undefined)} />
			)}
			{dialogs[0] && <Dialog key={dialogs[0].id} dialog={dialogs[0]} send={send} />}
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
