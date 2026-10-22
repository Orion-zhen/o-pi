import { ArrowUpRight, CodeXml, FolderSearch, Terminal } from "lucide-react";
import { motion } from "motion/react";
import { feedback } from "../../lib/motion";
import type { GuiSnapshot } from "../../../contract.ts";
import type { GuiControls, EditorControls } from "../gui-controls.ts";
import { Button } from "../../components/ui/button";
import { modelSetup } from "../../models/model-setup.ts";
import { WelcomeMark } from "./welcome-mark.tsx";
import { Spotlight } from "../../components/motion-primitives/spotlight";

const starters = [
	{ Icon: motion.create(FolderSearch), animation: { x: [0, -2, 1, 0] }, title: "了解项目", text: "梳理这个项目的结构，介绍主要模块和运行方式。" },
	{ Icon: motion.create(CodeXml), animation: { scale: [1, 0.92, 1] }, title: "审查代码", text: "审查当前工作区的代码变更，指出潜在问题和改进建议。" },
	{ Icon: motion.create(Terminal), animation: { opacity: [1, 0.35, 1] }, title: "开始构建", text: "我想实现一个新功能，请先了解项目并和我讨论实现方案。" },
];

export function Welcome({ snapshot, gui }: { snapshot: GuiSnapshot; gui: Pick<GuiControls, "canSubmit" | "setPanel"> & EditorControls }) {
	const setup = modelSetup(snapshot);
	return <>
		<WelcomeMark />
		{!setup && <p className="welcome-eyebrow">你的代码工作空间</p>}
		<h1>{setup?.title ?? "今天，想构建什么？"}</h1>
		{!setup && <p>从一个想法开始，一起把它变成现实。</p>}
		{setup ? <Button className="mt-6" disabled={!gui.canSubmit} onClick={() => gui.setPanel({ kind: setup.kind })}>
			{setup.action}
		</Button> : <div className="starter-grid">
			{starters.map(({ Icon, animation, title, text }) => <Button key={title} variant="outline" className="starter" asChild>
				<motion.button initial="idle" animate="idle" whileHover="active" whileFocus="active"
					onClick={() => { gui.setDraft(text); gui.editor.current?.focus(); }}>
					<Icon variants={{ idle: { x: 0, scale: 1, opacity: 1 }, active: animation }} transition={{ ...feedback, duration: 0.6 }} />
					<span>{title}</span><Spotlight /><ArrowUpRight />
				</motion.button>
			</Button>)}
		</div>}
	</>;
}
