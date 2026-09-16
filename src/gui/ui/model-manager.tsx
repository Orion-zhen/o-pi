import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { ListItem } from "./components/animated";
import { ArrowDown, ArrowUp, Check, Cpu, ListX, LoaderCircle, Play, Save, Search } from "lucide-react";
import type { GuiAction, GuiModel, GuiSnapshot } from "../contract.ts";
import type { Send } from "./connection.ts";
import { ThinkingControl } from "./model-controls.tsx";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import "./models.css";

export function ModelManager({ snapshot, send, disabled: blocked }: { snapshot: GuiSnapshot; send: Send; disabled: boolean }) {
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<GuiAction["action"] | null>(null);
	const [saved, setSaved] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const scope = snapshot.scopedModels;
	const signature = JSON.stringify(scope);
	const selected = new Set(scope);
	const available = new Map(snapshot.models.map((model) => [`${model.provider}/${model.id}`, model]));
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const matches = (model: GuiModel) =>
		terms.every((term) => `${model.provider}/${model.id} ${model.name}`.toLocaleLowerCase().includes(term));
	const selectedModels = scope.flatMap((id) => {
		const model = available.get(id);
		return model && matches(model) ? [model] : [];
	});
	const otherModels = snapshot.models.filter(
		(model) => !selected.has(`${model.provider}/${model.id}`) && matches(model),
	);
	const disabled = blocked || pending !== null;
	const run = async (action: GuiAction) => {
		setPending(action.action);
		setFailed(false);
		const ok = await send(action);
		if (ok && action.action === "persistModels") setSaved(signature);
		setFailed(!ok);
		setPending(null);
	};
	const update = (models: string[]) => {
		void run({ action: "scopeModels", models });
	};
	const move = (id: string, direction: -1 | 1) => {
		const index = scope.indexOf(id);
		const next = [...scope];
		next.splice(index, 1);
		next.splice(index + direction, 0, id);
		update(next);
	};
	const row = (model: GuiModel) => {
		const id = `${model.provider}/${model.id}`;
		const index = scope.indexOf(id);
		const active = snapshot.model?.provider === model.provider && snapshot.model.id === model.id;
		return (
			<ListItem className="model-row" key={id}>
				<Checkbox
					aria-label={`已选模型 ${id}`}
					checked={selected.has(id)}
					disabled={disabled}
					onCheckedChange={(checked) =>
						update(checked === true ? [...scope, id] : scope.filter((value) => value !== id))
					}
				/>
				<div className="model-name">
					<strong>{model.name}</strong>
					<small>{id}</small>
				</div>
				<div className="model-row-actions">
					{index >= 0 && (
						<>
							<IconButton
								label={`上移 ${id}`}
								size="icon-sm"
								disabled={disabled || index === 0}
								onClick={() => move(id, -1)}
							>
								<ArrowUp />
							</IconButton>
							<IconButton
								label={`下移 ${id}`}
								size="icon-sm"
								disabled={disabled || index === scope.length - 1}
								onClick={() => move(id, 1)}
							>
								<ArrowDown />
							</IconButton>
						</>
					)}
					<IconButton
						label={active ? `当前模型 ${id}` : `使用模型 ${id}`}
						size="icon-sm"
						variant={active ? "secondary" : "ghost"}
						disabled={disabled || active}
						onClick={() => void run({ action: "model", provider: model.provider, id: model.id })}
					>
						{active ? <Check /> : <Play />}
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
				<ThinkingControl snapshot={snapshot} send={send} disabled={disabled} />
			</div>
			<label className="model-search">
				<Search aria-hidden="true" />
				<Input
					aria-label="搜索模型"
					placeholder="搜索名称、提供方或模型 ID"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</label>
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
				<p className="model-save-status" role="status">
					{failed
						? "操作失败，请关闭面板查看错误后重试。"
						: saved === signature
							? "已保存模型。"
							: "勾选和排序仅影响当前会话，保存后供下次启动使用。"}
				</p>
				<Button disabled={disabled} onClick={() => void run({ action: "persistModels" })}>
					{pending === "persistModels" ? <LoaderCircle className="animate-spin" /> : <Save />}
					保存模型
				</Button>
			</footer>
		</section>
	);
}
