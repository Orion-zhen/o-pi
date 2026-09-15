import { useEffect, useState } from "react";
import type { GuiView } from "./use-gui.ts";

export function Sidebar({ gui, visible, close }: { gui: GuiView; visible: boolean; close: () => void }) {
	const [workspace, setWorkspace] = useState("");
	useEffect(() => {
		if (gui.snapshot) setWorkspace(gui.snapshot.cwd);
	}, [gui.snapshot?.cwd]);
	const command = (text: string) => {
		close();
		gui.command(text);
	};
	return (
		<aside className={`sidebar ${visible ? "visible" : ""}`}>
			<h1>
				o-pi <small>GUI MVP</small>
			</h1>
			<button
				onClick={() => {
					void gui.send({ action: "new" });
					close();
				}}
			>
				新建会话
			</button>
			<form
				className="workspace-form"
				onSubmit={(event) => {
					event.preventDefault();
					void gui.send({ action: "workspace", path: workspace });
				}}
			>
				<label>
					工作目录
					<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
				</label>
				<button>打开</button>
				{window.opi && (
					<button
						type="button"
						onClick={() => {
							void window.opi
								?.chooseDirectory()
								.then((directory) => {
									if (directory) {
										setWorkspace(directory);
										void gui.send({ action: "workspace", path: directory });
									}
								})
								.catch((error: unknown) => gui.setError(String(error)));
						}}
					>
						选择目录
					</button>
				)}
			</form>
			<nav>
				{[
					["resume", "会话"],
					["tree", "会话树"],
					["tools", "工具"],
					["model", "模型"],
					["login", "认证"],
					["settings", "设置"],
					["stats", "统计"],
					["system", "系统提示词"],
					["usage", "套餐用量"],
					["telemetry", "遥测"],
					["skill", "已加载技能"],
					["help", "命令帮助"],
				].map(([name, label]) => (
					<button key={name} onClick={() => command(`/${name}`)}>
						{label}
					</button>
				))}
			</nav>
			<div className="toolbar">
				<button onClick={() => command("/reload")}>重载</button>
				<button onClick={() => command("/import")}>导入</button>
				<button onClick={() => command("/export jsonl")}>导出 JSONL</button>
				<button onClick={() => command("/export")}>导出 HTML</button>
			</div>
			<button className="mobile-menu" onClick={close}>
				关闭菜单
			</button>
		</aside>
	);
}
