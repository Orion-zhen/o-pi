import type { ServiceCompatSettings } from "../../../../../harness/model-services/compat-settings.ts";
import { Disclosure } from "@/ui/disclosure.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { ServiceBoolean, ServiceChoice } from "./service-fields.tsx";

export function ServiceCompat({ settings, reasoning, disabled, change }: {
	settings: ServiceCompatSettings;
	reasoning?: boolean;
	disabled: boolean;
	change: ChangeConfig;
}) {
	const { api, own, defaults, capabilities } = settings;
	if (capabilities === undefined) return null;
	const completions = api === "openai-completions";
	const effortUnavailable = capabilities.effortControl === "unused" ? "当前模板不使用独立 reasoning_effort 参数。"
		: reasoning === false ? "开启思考能力后可配置此参数。" : undefined;
	const flags = completions
		? [["supportsDeveloperRole", "Developer 角色"], ["supportsStore", "服务端存储"]] as const
		: [["supportsDeveloperRole", "Developer 角色"]] as const;
	return <Disclosure className="service-disclosure" summary="协议与思考" lazy>
		<div className="settings-fields">
			{completions && <ServiceChoice label="输出上限字段" value={own.maxTokensField} defaultValue={defaults.maxTokensField}
				options={[["max_tokens", "max_tokens"], ["max_completion_tokens", "max_completion_tokens"]]}
				disabled={disabled} change={(value) => change(["compat", "maxTokensField"], value)} />}
			{flags.map(([key, label]) => <ServiceBoolean key={key} label={label}
				value={own[key]} defaultValue={defaults[key]} placeholder="因模型而异"
				disabled={disabled} change={(value) => change(["compat", key], value)} />)}
			{completions && <ServiceBoolean label="独立 reasoning_effort 参数" value={own.supportsReasoningEffort}
				defaultValue={defaults.supportsReasoningEffort} unavailable={effortUnavailable}
				hint={capabilities.effortControl === "off-only" ? "仅影响 off 等级，其余等级使用 reasoning.effort。" : undefined}
				disabled={disabled} change={(value) => change(["compat", "supportsReasoningEffort"], value)} />}
		</div>
	</Disclosure>;
}
