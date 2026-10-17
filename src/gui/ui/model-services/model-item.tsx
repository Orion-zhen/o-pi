import { ChevronRight, RotateCcw } from "lucide-react";
import { configObject } from "../../../harness/openai-compatible-provider/document.ts";
import type { ModelSettings } from "../../../harness/openai-compatible-provider/model-settings.ts";
import type { ModelSettingsView } from "../../../harness/openai-compatible-provider/settings-view.ts";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button.tsx";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Disclosure } from "../components/disclosure.tsx";
import { Reveal } from "../components/animated.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { ServiceBoolean, ServiceChoice, ServiceInput, ServiceNumber, ServiceText, textValue, thinkingChoices } from "./service-fields.tsx";
import { ServiceCompat } from "./service-compat.tsx";
import { ServiceThinking } from "./service-thinking.tsx";

export function ModelItem({ model, settings, open, setOpen, disabled, change }: {
	model: ModelSettings;
	settings: ModelSettingsView;
	open: boolean;
	setOpen: (open: boolean) => void;
	disabled: boolean;
	change: ChangeConfig;
}) {
	const { defaults, compat, thinking, overrides } = settings;
	const { id, configured: fields, manualIndex } = model;
	const name = textValue(fields.name) || textValue(model.defaults.name) || id;
	const sampling = configObject(fields.samplingParams) ? fields.samplingParams : {};
	const defaultSampling = configObject(defaults.samplingParams) ? defaults.samplingParams : {};
	const edit: ChangeConfig = (path, value) => change([...model.path, ...path], value);
	const outputHint = model.defaults.maxTokens === undefined ? "不限制（由服务端决定）" : `继承：${textValue(model.defaults.maxTokens)}`;

	return <Reveal><Collapsible open={open} onOpenChange={setOpen} asChild>
		<article className="service-model" aria-label={`模型 ${id}`}>
			<div className="service-item-heading">
				<CollapsibleTrigger className="service-summary" aria-label={`编辑模型 ${id}`}>
					<strong>{name}</strong>{name !== id && <span>{id}</span>}
				</CollapsibleTrigger>
				<div className="service-item-actions">
					{model.overridden && Object.keys(overrides).length > 0 && <IconButton size="icon-sm"
						label={`还原模型设置 ${id}`} tooltip="还原模型设置" disabled={disabled}
						onClick={() => change(["modelOverrides", id], undefined)}><RotateCcw /></IconButton>}
					{manualIndex !== undefined && <ConfirmAction label={`删除模型 ${id}`} disabled={disabled}
						confirm={async () => change(["models", manualIndex], undefined)} />}
					<CollapsibleTrigger className="disclosure-trigger" asChild>
						<Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"}模型 ${id}`}>
							<ChevronRight className="disclosure-chevron" />
						</Button>
					</CollapsibleTrigger>
				</div>
			</div>
			<CollapsibleContent lazy><div className="service-model-form">
				<ServiceText label="模型名称" value={fields.name} defaultValue={defaults.name} placeholder={textValue(defaults.name)}
					disabled={disabled} change={(value) => edit(["name"], value)} />
				<ServiceNumber label="上下文 Token" value={fields.contextWindow} defaultValue={defaults.contextWindow}
					placeholder={textValue(defaults.contextWindow)} disabled={disabled} change={(value) => edit(["contextWindow"], value)} />
				<ServiceNumber label="最大输出 Token" value={fields.maxTokens} defaultValue={defaults.maxTokens}
					placeholder={outputHint} disabled={disabled} change={(value) => edit(["maxTokens"], value)} />
				<ServiceInput label="输入类型" value={fields.input} defaultValue={defaults.input}
					disabled={disabled} change={(value) => edit(["input"], value)} />
				<ServiceBoolean label="思考能力" value={fields.reasoning} defaultValue={defaults.reasoning}
					disabled={disabled} change={(value) => edit(["reasoning"], value)} />
				<ServiceChoice label="默认思考等级" value={fields.defaultThinkingLevel} defaultValue={defaults.defaultThinkingLevel}
					options={thinkingChoices} unsetLabel="不指定" disabled={disabled} change={(value) => edit(["defaultThinkingLevel"], value)} />
				<Disclosure className="service-disclosure" summary="采样参数" lazy><div className="settings-fields">
					{([["temperature", "温度"], ["top_p", "Top P"], ["top_k", "Top K"]] as const).map(([key, label]) =>
						<ServiceNumber key={key} label={label} value={sampling[key]} defaultValue={defaultSampling[key]}
							placeholder={textValue(defaultSampling[key])} disabled={disabled} change={(value) => edit(["samplingParams", key], value)} />)}
				</div></Disclosure>
				<ServiceCompat config={fields} defaults={compat} disabled={disabled} change={edit} />
				<ServiceThinking mapping={thinking} disabled={disabled} change={edit} />
			</div></CollapsibleContent>
		</article>
	</Collapsible></Reveal>;
}
