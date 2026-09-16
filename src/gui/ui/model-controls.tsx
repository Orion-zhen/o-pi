import { useRef } from "react";
import { Cpu } from "lucide-react";
import type { GuiSnapshot } from "../contract.ts";
import type { Send } from "./dialog.tsx";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "./components/ui/select";

const manageModels = "manage-models";

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
			disabled={disabled || snapshot.busy || snapshot.streaming}
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

export function ModelControls({ snapshot, send }: { snapshot: GuiSnapshot; send: Send }) {
	const openManager = useRef(false);
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
			<Select
				value={current}
				disabled={snapshot.busy || snapshot.streaming}
				onValueChange={(value) => {
					if (value === manageModels) {
						openManager.current = true;
						return;
					}
					const model = available.get(value);
					if (model) void send({ action: "model", provider: model.provider, id: model.id });
				}}
			>
				<SelectTrigger aria-label="模型" title={current || "选择或管理模型"}>
					<SelectValue placeholder="选择模型" />
				</SelectTrigger>
				<SelectContent onCloseAutoFocus={(event) => {
					if (!openManager.current) return;
					openManager.current = false;
					event.preventDefault();
					// 等下拉菜单释放焦点后再打开模型弹窗。
					void send({ action: "view", view: "model" });
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
			<ThinkingControl snapshot={snapshot} send={send} />
		</div>
	);
}
