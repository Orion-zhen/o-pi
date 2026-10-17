import type { ServiceCompatDefaults } from "../../../harness/openai-compatible-provider/compat-defaults.ts";
import { configObject, type ConfigObject } from "../../../harness/openai-compatible-provider/document.ts";
import { Disclosure } from "../components/disclosure.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { presetChoices, ServiceBoolean, ServiceChoice } from "./service-fields.tsx";

export function ServiceCompat({ config, defaults, disabled, change }: {
	config: ConfigObject;
	defaults: ServiceCompatDefaults;
	disabled: boolean;
	change: ChangeConfig;
}) {
	const completions = defaults.api === "openai-completions";
	const compat = configObject(config.compat) ? config.compat : {};
	const flags = completions
		? [["supportsDeveloperRole", "Developer 角色"], ["supportsStore", "服务端存储"], ["supportsReasoningEffort", "思考强度参数"]] as const
		: [["supportsDeveloperRole", "Developer 角色"]] as const;
	return <Disclosure className="service-disclosure" summary="协议与思考" lazy>
		<div className="settings-fields">
			<ServiceChoice label="思考传递方式" value={config.thinkingPreset} defaultValue={defaults.thinkingPreset}
				options={presetChoices} disabled={disabled} change={(value) => change(["thinkingPreset"], value)} />
			{completions && <ServiceChoice label="输出上限字段" value={compat.maxTokensField} defaultValue={defaults.compat.maxTokensField}
				options={[["max_tokens", "max_tokens"], ["max_completion_tokens", "max_completion_tokens"]]}
				disabled={disabled} change={(value) => change(["compat", "maxTokensField"], value)} />}
			{flags.map(([key, label]) => <ServiceBoolean key={key} label={label}
				value={compat[key]} defaultValue={defaults.compat[key]} placeholder="因模型而异"
				disabled={disabled} change={(value) => change(["compat", key], value)} />)}
		</div>
	</Disclosure>;
}
