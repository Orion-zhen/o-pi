import { configObject, type ConfigObject } from "../../../harness/openai-compatible-provider/validation.ts";
import { Disclosure } from "../components/disclosure.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { formatChoices, presetChoices, ServiceBoolean, ServiceChoice } from "./service-fields.tsx";

export function ServiceCompat({ config, api, disabled, change }: { config: ConfigObject; api: unknown; disabled: boolean; change: ChangeConfig }) {
	const completions = api === "openai-completions";
	const compat = configObject(config.compat) ? config.compat : {};
	const flags = completions ? [["supportsDeveloperRole", "Developer 角色"], ["supportsStore", "服务端存储"], ["supportsReasoningEffort", "思考强度参数"]] as const
		: [["supportsDeveloperRole", "Developer 角色"]] as const;
	return <Disclosure className="service-disclosure" summary="协议与思考" lazy>
		<div className="settings-fields">
			<ServiceChoice label="思考编码" value={config.thinkingPreset} disabled={disabled} change={(value) => change(["thinkingPreset"], value)}
				options={completions ? [["model-suffix", "模型后缀"]] : presetChoices} />
			{completions && <ServiceChoice label="思考格式" value={compat.thinkingFormat} options={formatChoices} disabled={disabled} change={(value) => change(["compat", "thinkingFormat"], value)} />}
			{completions && <ServiceChoice label="输出上限字段" value={compat.maxTokensField} options={[["max_tokens", "max_tokens"], ["max_completion_tokens", "max_completion_tokens"]]}
				disabled={disabled} change={(value) => change(["compat", "maxTokensField"], value)} />}
			{flags.map(([key, label]) => <ServiceBoolean key={key} label={label}
					value={compat[key]} disabled={disabled} change={(value) => change(["compat", key], value)} />)}
		</div>
	</Disclosure>;
}
