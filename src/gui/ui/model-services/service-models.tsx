import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, Plus, RotateCcw } from "lucide-react";
import type { ServiceModel } from "../../model-services.ts";
import { configObject, type ConfigObject } from "../../../harness/openai-compatible-provider/validation.ts";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button.tsx";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Disclosure } from "../components/disclosure.tsx";
import { Reveal } from "../components/animated.tsx";
import { serviceModels, type ChangeConfig } from "./service-draft.ts";
import { AddServiceItem, ServiceBoolean, ServiceChoice, ServiceText, textValue, thinkingChoices } from "./service-fields.tsx";
import { ServiceCompat } from "./service-compat.tsx";
import { ServiceThinking } from "./service-thinking.tsx";

const inputTypes: Record<string, string[]> = { text: ["text"], "text-image": ["text", "image"] };
function inputChoice(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) {
		for (const [key, input] of Object.entries(inputTypes)) {
			if (value.length === input.length && value.every((item, index) => item === input[index])) return key;
		}
	}
	return JSON.stringify(value);
}

export function ServiceModels({ provider, catalog, disabled, change }: {
	provider: ConfigObject; catalog: ServiceModel[]; disabled: boolean; change: ChangeConfig;
}) {
	const [adding, setAdding] = useState(false);
	const [expanded, setExpanded] = useState<string>();
	const models = serviceModels(provider, catalog);
	return <section className="service-models" aria-label="服务模型">
		<header className="service-section-heading"><h4>模型</h4><Button variant="ghost" size="sm" disabled={disabled} onClick={() => setAdding(!adding)}><Plus />添加模型</Button></header>
		<AnimatePresence initial={false}>{adding && <Reveal key="add"><AddServiceItem label="模型 ID" disabled={disabled} existing={models.map(({ id }) => id)} cancel={() => setAdding(false)} add={(id) => {
			const index = Array.isArray(provider.models) ? provider.models.length : 0;
			change(["models", index], { id }); setAdding(false); setExpanded(id);
		}} /></Reveal>}</AnimatePresence>
		<div className="service-model-list"><AnimatePresence initial={false}>
			{models.map((model) => {
				const open = expanded === model.id;
				const fields = model.configured;
				const manualIndex = model.manualIndex;
				const sampling = configObject(fields.samplingParams) ? fields.samplingParams : {};
				const edit: ChangeConfig = (path, value) => change([...model.path, ...path], value);
				const name = textValue(fields.name) || textValue(model.defaults.name) || model.id;
				return <Reveal key={model.id}><Collapsible open={open} onOpenChange={(next) => setExpanded(next ? model.id : undefined)} asChild>
					<article className="service-model" aria-label={`模型 ${model.id}`}>
						<div className="service-item-heading">
							<CollapsibleTrigger className="service-summary" aria-label={`编辑模型 ${model.id}`}><strong>{name}</strong>{name !== model.id && <span>{model.id}</span>}</CollapsibleTrigger>
							<div className="service-item-actions">
								{model.overridden && <IconButton size="icon-sm" label={`还原模型设置 ${model.id}`} tooltip="还原模型设置" disabled={disabled}
									onClick={() => change(["modelOverrides", model.id], undefined)}><RotateCcw /></IconButton>}
								{manualIndex !== undefined && <ConfirmAction label={`删除模型 ${model.id}`} disabled={disabled} confirm={async () => change(["models", manualIndex], undefined)} />}
								<CollapsibleTrigger className="disclosure-trigger" asChild><Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"}模型 ${model.id}`}><ChevronRight className="disclosure-chevron" /></Button></CollapsibleTrigger>
							</div>
						</div>
						<CollapsibleContent lazy><div className="service-model-form">
							<ServiceText label="模型名称" value={fields.name} disabled={disabled} change={(value) => edit(["name"], value)} />
							<ServiceText label="上下文 Token" value={fields.contextWindow} numeric disabled={disabled} placeholder={textValue(model.defaults.contextWindow) || "128000"} change={(value) => edit(["contextWindow"], value)} />
							<ServiceText label="最大输出 Token" value={fields.maxTokens} numeric disabled={disabled} placeholder={textValue(model.defaults.maxTokens) || "16384"} change={(value) => edit(["maxTokens"], value)} />
							<ServiceChoice label="输入类型" value={inputChoice(fields.input)} disabled={disabled} options={[["text", "文本"], ["text-image", "文本与图片"]]}
								change={(value) => edit(["input"], value === undefined ? undefined : inputTypes[value])} />
							<ServiceBoolean label="思考能力" value={fields.reasoning} disabled={disabled} change={(value) => edit(["reasoning"], value)} />
							<ServiceChoice label="默认思考等级" value={fields.defaultThinkingLevel} options={thinkingChoices} defaultLabel="不指定" disabled={disabled} change={(value) => edit(["defaultThinkingLevel"], value)} />
							<Disclosure className="service-disclosure" summary="采样参数" lazy><div className="settings-fields">
								{([["temperature", "温度"], ["top_p", "Top P"], ["top_k", "Top K"]] as const).map(([key, label]) => <ServiceText key={key} label={label} value={sampling[key]}
									numeric disabled={disabled} change={(value) => edit(["samplingParams", key], value)} />)}
							</div></Disclosure>
							<ServiceCompat config={fields} api={fields.api ?? model.defaults.api ?? provider.api} disabled={disabled} change={edit} />
							<ServiceThinking provider={provider} defaults={model.defaults} configured={fields} modelId={model.id} disabled={disabled} change={edit} />
						</div></CollapsibleContent>
					</article>
				</Collapsible></Reveal>;
			})}
		</AnimatePresence></div>
		{models.length === 0 && !adding && <p className="settings-empty">暂无模型</p>}
	</section>;
}
