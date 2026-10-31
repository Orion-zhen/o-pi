import { useEffect, useRef, useState } from "react";
import { cancelFrame, frame, resize } from "motion";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Cpu } from "lucide-react";
import { Rocket, Zap } from "lucide";
import { MorphIcon } from "morphicons/react";
import { CODEX_SPEEDS, type CodexSpeed } from "../../../../harness/codex-speed/state.ts";
import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { TransitionPanel } from "@/ui/motion/transition-panel.tsx";
import { TextMorph } from "@/ui/motion/text-morph.tsx";
import { controlShift, listDepth, settle } from "@/ui/motion/transitions.ts";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import "./models.css";

const manageModels = "manage-models";
const thinkingOrder = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function CodexSpeedControl({ speed, send, disabled }: { speed: CodexSpeed; send: Send; disabled: boolean }) {
	const present = useIsPresent();
	const text = useRef<HTMLSpanElement>(null);
	const [textWidth, setTextWidth] = useState<number>();
	const accelerated = speed !== "normal";
	useEffect(() => {
		if (!text.current) return;
		let width: number;
		const update = () => setTextWidth(width);
		const stop = resize(text.current, (_, size) => {
			width = size.width;
			frame.update(update);
		});
		return () => { stop(); cancelFrame(update); };
	}, []);
	return (
		<motion.div className="flex shrink-0 overflow-clip" inert={!present} aria-hidden={!present}
			initial={{ width: 0, marginRight: "-0.25rem" }} animate={{ width: "auto", marginRight: "0rem" }}
			exit={{ width: 0, marginRight: "-0.25rem" }} transition={listDepth.transition}>
		<motion.div className="flex w-max shrink-0" initial={listDepth.hidden} animate={listDepth.visible} exit={listDepth.hidden} transition={listDepth.transition}>
		<Select value={speed} disabled={disabled} onValueChange={(value) => {
			const next = CODEX_SPEEDS.find((speed) => speed === value);
			if (next) void send({ action: "codexSpeed", speed: next });
		}}>
			<Hint content={`模型速度：${speed}`}><SelectTrigger className="codex-speed" data-speed={speed} aria-label={`模型速度：${speed}`}>
				<span className="codex-speed-label">
					<motion.span className="codex-speed-icon" initial={false} animate={{ x: accelerated ? -3 : 0 }} transition={controlShift}>
						<MorphIcon icon={speed === "ultrafast" ? Rocket : Zap} spring="smooth" size="1em" />
					</motion.span>
					<motion.span className="codex-speed-text" initial={false}
						animate={{ width: accelerated ? textWidth ?? "auto" : 0, marginLeft: accelerated ? "0.5em" : "0em" }} transition={controlShift}>
						<span ref={text} className="codex-speed-text-content"><TextMorph transition={controlShift}>{accelerated ? speed : ""}</TextMorph></span>
					</motion.span>
				</span>
			</SelectTrigger></Hint>
			<SelectContent>
				{CODEX_SPEEDS.map((speed) => <SelectItem key={speed} value={speed}>{speed}</SelectItem>)}
			</SelectContent>
		</Select>
		</motion.div>
		</motion.div>
	);
}

export function ThinkingControl({
	snapshot,
	send,
	disabled = false,
}: {
	snapshot: GuiSnapshot;
	send: Send;
	disabled?: boolean;
}) {
	return (
		<Select
			value={snapshot.thinking}
			disabled={disabled}
			onValueChange={(value) => {
				const level = snapshot.thinkingLevels.find((level) => level === value);
				if (level) void send({ action: "thinking", level });
			}}
		>
			<SelectTrigger aria-label="思考级别"><SelectValue>
				<TransitionPanel activeIndex={thinkingOrder.indexOf(snapshot.thinking)} axis="y">{snapshot.thinking}</TransitionPanel>
			</SelectValue></SelectTrigger>
			<SelectContent>
				{snapshot.thinkingLevels.map((level) => (
					<SelectItem key={level} value={level}>{level}</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function ModelControls({ snapshot, send, disabled, openManager }: {
	snapshot: GuiSnapshot; send: Send; disabled: boolean; openManager: () => void;
}) {
	const manageOnClose = useRef(false);
	const name = useRef<HTMLSpanElement>(null);
	const [nameWidth, setNameWidth] = useState<number>();
	useEffect(() => {
		if (!name.current) return;
		let width: number;
		const update = () => setNameWidth(width);
		const stop = resize(name.current, (_, size) => {
			width = size.width;
			frame.update(update);
		});
		return () => { stop(); cancelFrame(update); };
	}, []);
	const available = new Map(snapshot.models.map((model) => [`${model.provider}/${model.id}`, model]));
	const models = snapshot.scopedModels.flatMap((id) => {
		const model = available.get(id);
		return model ? [model] : [];
	});
	const current = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
	if (snapshot.model && !models.some((model) => `${model.provider}/${model.id}` === current))
		models.push(snapshot.model);
	return (
		<div className="model-controls">
			<AnimatePresence initial={false}>
				{snapshot.codexSpeed !== null && <CodexSpeedControl speed={snapshot.codexSpeed} send={send} disabled={disabled} />}
			</AnimatePresence>
			<Select
				value={current}
				disabled={disabled}
				onValueChange={(value) => {
					if (value === manageModels) {
						manageOnClose.current = true;
						return;
					}
					const model = available.get(value);
					if (model) void send({ action: "model", provider: model.provider, id: model.id });
				}}
			>
				<Hint content={current || "选择模型"}><SelectTrigger className="model-control" aria-label="模型">
					<motion.span initial={false} animate={{ width: nameWidth ?? "auto" }} transition={settle}>
						<span ref={name} className="model-control-name"><TextMorph>{snapshot.model?.name ?? "选择模型"}</TextMorph></span>
					</motion.span>
				</SelectTrigger></Hint>
				<SelectContent onCloseAutoFocus={(event) => {
					if (!manageOnClose.current) return;
					manageOnClose.current = false;
					event.preventDefault();
					// 等下拉菜单释放焦点后再打开模型弹窗。
					openManager();
				}}>
					{models.map((model) => (
						<SelectItem key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
							{model.name}
						</SelectItem>
					))}
					{models.length > 0 && <SelectSeparator className="my-1 h-px bg-border" />}
					<SelectItem value={manageModels} textValue="管理模型">
						<span className="flex items-center gap-2"><Cpu className="size-[1em]" aria-hidden="true" />管理模型</span>
					</SelectItem>
				</SelectContent>
			</Select>
			<ThinkingControl snapshot={snapshot} send={send} disabled={disabled} />
			{snapshot.routedModel && <Hint content={`${snapshot.routedModel.model.provider}/${snapshot.routedModel.model.id}`}><span className="truncate text-xs text-muted-foreground" aria-label="最近响应模型">
				→ {snapshot.routedModel.model.name}{snapshot.routedModel.thinkingLevel === undefined ? "" : ` · ${snapshot.routedModel.thinkingLevel}`}
			</span></Hint>}
		</div>
	);
}
