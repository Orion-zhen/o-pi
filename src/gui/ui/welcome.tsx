import { ArrowUpRight, Code2, FolderSearch, Terminal } from "lucide-react";
import type { GuiSnapshot } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { Button } from "./components/ui/button";
import { modelSetup } from "./model-setup.ts";

const starters = [
	{ icon: FolderSearch, title: "了解项目", text: "梳理这个项目的结构，介绍主要模块和运行方式。" },
	{ icon: Code2, title: "审查代码", text: "审查当前工作区的代码变更，指出潜在问题和改进建议。" },
	{ icon: Terminal, title: "开始构建", text: "我想实现一个新功能，请先了解项目并和我讨论实现方案。" },
];

export function Welcome({ snapshot, gui }: { snapshot: GuiSnapshot; gui: GuiView }) {
	const setup = modelSetup(snapshot);
	return <>
		<div className="welcome-mark"><span className="app-logo" role="img" aria-label="opi" /></div>
		{!setup && <p className="welcome-eyebrow">你的代码工作空间</p>}
		<h1>{setup?.title ?? "今天，想构建什么？"}</h1>
		{!setup && <p>从一个想法开始，一起把它变成现实。</p>}
		{setup ? <Button className="mt-6" disabled={!gui.canChangeSession} onClick={() => gui.setPanel({ kind: setup.kind })}>
			{setup.action}
		</Button> : <div className="starter-grid">
			{starters.map(({ icon: Icon, title, text }) => <Button
				key={title} variant="outline" className="starter"
				onClick={() => { gui.setDraft(text); gui.editor.current?.focus(); }}
			>
				<Icon /><span>{title}</span><ArrowUpRight />
			</Button>)}
		</div>}
	</>;
}
