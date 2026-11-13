import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { ListItem } from "@/ui/motion/animated.tsx";
import { ArrowDown, ArrowUp, Cpu, ListX, LoaderCircle, Search } from "lucide-react";
import { Check, LoaderCircle as LoaderCircleData, Play, Save } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { ThinkingControl } from "./model-controls.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { Checkbox } from "@/ui/checkbox.tsx";
import { SearchInput } from "@/ui/search-input.tsx";
import "./models.css";

export function ModelManager({ snapshot, send, disabled: blocked }: { snapshot: GuiSnapshot; send: Send; disabled: boolean }) {
	const [query, setQuery] = useState("");
	const [saved, setSaved] = useState<string | null>(null);
	const defaults = snapshot.defaultModel;
	const scope = snapshot.scopedModels;
	const signature = JSON.stringify(scope);
	const selected = new Map(scope.map((id, index) => [id, index]));
	const available = new Map(snapshot.models.map((model) => [`${model.provider}/${model.id}`, model]));
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const matches = (id: string) =>
		terms.every((term) => `${id} ${available.get(id)?.name ?? ""}`.toLocaleLowerCase().includes(term));
	const selectedModels = scope.filter(matches);
	const otherModels = [...available.keys()].filter((id) => !selected.has(id) && matches(id));
	const operation = useOperation((action: Parameters<Send>[0]) => send(action).then(() => signature), (saved, action) => {
		if (action.action === "persistModels") setSaved(saved);
	});
	const { run, error } = operation;
	const pending = operation.state.state === "pending" ? operation.state.args[0].action : null;
	const defaultSaved = operation.state.state === "succeeded" && operation.state.args[0].action === "persistDefaultModel";
	const disabled = blocked || operation.pending;
	const update = (models: string[]) => {
		void run({ action: "scopeModels", models });
	};
	const move = (id: string, index: number, direction: -1 | 1) => {
		const next = [...scope];
		next.splice(index, 1);
		next.splice(index + direction, 0, id);
		update(next);
	};
	const row = (id: string) => {
		const model = available.get(id);
		const index = selected.get(id);
		const active = model && snapshot.model?.provider === model.provider && snapshot.model.id === model.id;
		return (
			<ListItem className={`model-row${model ? "" : " model-row-unavailable"}`} key={id}>
				<Checkbox
					aria-label={`已选模型 ${id}`}
					checked={selected.has(id)}
					disabled={disabled}
					onCheckedChange={(checked) =>
						update(checked === true ? [...scope, id] : scope.filter((value) => value !== id))
					}
				/>
				<div className="model-name">
					<strong>{model?.name ?? id}</strong>
					<small>{model ? id : "不可用"}</small>
				</div>
				<div className="model-row-actions">
					{index !== undefined && (
						<>
							<IconButton
								label={`上移 ${id}`} tooltip="上移"
								size="icon-sm"
								disabled={disabled || index === 0}
								onClick={() => move(id, index, -1)}
							>
								<ArrowUp />
							</IconButton>
							<IconButton
								label={`下移 ${id}`} tooltip="下移"
								size="icon-sm"
								disabled={disabled || index === scope.length - 1}
								onClick={() => move(id, index, 1)}
							>
								<ArrowDown />
							</IconButton>
						</>
					)}
					<IconButton
						label={active ? `当前模型 ${id}` : `使用模型 ${id}`}
						tooltip={active ? "当前模型" : "使用模型"}
						size="icon-sm"
						variant={active ? "secondary" : "ghost"}
						disabled={disabled || !model || active}
						onClick={() => { if (model) void run({ action: "model", provider: model.provider, id: model.id }); }}
					>
						<MorphIcon icon={active ? Check : Play} spring="smooth" size="1em" />
					</IconButton>
				</div>
			</ListItem>
		);
	};
	return (
		<section className="model-manager" aria-label="模型管理">
			<div className="current-model">
				<Cpu aria-hidden="true" />
				<div>
					<small>当前模型</small>
					<strong>{snapshot.model?.name ?? "尚未选择"}</strong>
				</div>
				<ThinkingControl snapshot={snapshot} change={(level) => void run({ action: "thinking", level })} disabled={disabled} />
				<Button variant="outline" disabled={disabled || !snapshot.model}
					onClick={() => void run({ action: "persistDefaultModel" })}>
					{pending === "persistDefaultModel" && <LoaderCircle className="animate-spin" />}
					设为默认
				</Button>
			</div>
			<p className="model-default-summary">
				全局默认：{defaults.provider ?? "未设置提供方"} / {defaults.id ?? "未设置模型"} · {defaults.thinking ?? "未设置思考等级"}
			</p>
			<div className="model-search">
				<Search aria-hidden="true" />
				<SearchInput
					aria-label="搜索模型"
					placeholder="搜索名称、提供方或模型 ID"
					value={query}
					onValueChange={setQuery}
				/>
			</div>
			<div className="model-manager-toolbar">
				<p>已选 {scope.length} 个模型</p>
				<IconButton label="清空已选模型" disabled={disabled || !scope.length} onClick={() => update([])}>
					<ListX />
				</IconButton>
			</div>
			<div className="model-catalog">
				<section aria-label="已选模型">
					<h3>已选模型</h3>
					<ul><AnimatePresence initial={false}>{selectedModels.map(row)}</AnimatePresence></ul>
					{selectedModels.length === 0 && (
						<p className="model-empty">
							{scope.length ? "没有匹配的已选模型。" : "添加常用模型后，可在输入框中快速切换。"}
						</p>
					)}
				</section>
				<section aria-label="可用模型">
					<h3>可用模型</h3>
					<ul><AnimatePresence initial={false}>{otherModels.map(row)}</AnimatePresence></ul>
					{otherModels.length === 0 && (
						<p className="model-empty">
							{snapshot.models.length ? "没有其他匹配的模型。" : "暂无可用模型，请先配置认证。"}
						</p>
					)}
				</section>
			</div>
			<footer className="model-manager-footer">
				<Feedback message={defaultSaved ? "已保存默认模型和思考等级"
					: saved === signature && !snapshot.modelScopeChanged ? "已保存常用模型" : "切换仅影响当前会话"} />
				<Button disabled={disabled || !snapshot.modelScopeChanged} aria-busy={pending === "persistModels"} onClick={() => void run({ action: "persistModels" })}>
					<MorphIcon icon={pending === "persistModels" ? LoaderCircleData : Save} spring="smooth" size="1em"
						className={pending === "persistModels" ? "animate-spin" : undefined} />
					保存常用模型
				</Button>
			</footer>
			<Feedback compact message={error} tone="error" />
		</section>
	);
}
