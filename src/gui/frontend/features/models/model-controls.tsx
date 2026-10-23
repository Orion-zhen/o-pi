import { useRef } from "react";
import { Cpu } from "lucide-react";
import { Rocket, Zap } from "lucide";
import { MorphIcon } from "morphicons/react";
import { CODEX_SPEEDS, type CodexSpeed } from "../../../../harness/codex-speed/state.ts";
import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import "./models.css";

const manageModels = "manage-models";

function CodexSpeedControl({ speed, send, disabled }: { speed: CodexSpeed; send: Send; disabled: boolean }) {
	return (
		<Select value={speed} disabled={disabled} onValueChange={(value) => {
			const next = CODEX_SPEEDS.find((speed) => speed === value);
			if (next) void send({ action: "codexSpeed", speed: next });
		}}>
			<Hint content={`模型速度：${speed}`}><SelectTrigger className="codex-speed" data-speed={speed} aria-label={`模型速度：${speed}`}>
				<span className="codex-speed-label"><MorphIcon icon={speed === "ultrafast" ? Rocket : Zap} spring="smooth" size="1em" />{speed !== "normal" && <span>{speed}</span>}</span>
			</SelectTrigger></Hint>
			<SelectContent>
				{CODEX_SPEEDS.map((speed) => <SelectItem key={speed} value={speed}>{speed}</SelectItem>)}
			</SelectContent>
		</Select>
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
			<SelectTrigger aria-label="思考级别"><SelectValue /></SelectTrigger>
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
			{snapshot.codexSpeed !== null && <CodexSpeedControl speed={snapshot.codexSpeed} send={send} disabled={disabled} />}
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
					<SelectValue placeholder="选择模型" />
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
