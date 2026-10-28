import { AnimatePresence } from "motion/react";
import { Reveal } from "@/ui/motion/animated.tsx";
import { THINKING_FORMATS, type ServiceCompatSettings } from "../../../../../harness/model-services/compat-settings.ts";
import type { ChangeConfig } from "./service-draft.ts";
import { ServiceChoice } from "./service-fields.tsx";
import { ServiceTemplateParams } from "./service-template-params.tsx";

export function ServiceThinkingFormat({ settings, disabled, change }: {
	settings: ServiceCompatSettings;
	disabled: boolean;
	change: ChangeConfig;
}) {
	const { api, own, defaults, templateKey } = settings;
	return <>
		{api === "openai-completions" && <ServiceChoice label="思考格式" value={own.thinkingFormat} defaultValue={defaults.thinkingFormat}
			options={THINKING_FORMATS.map((format) => [format, format] as const)} disabled={disabled}
			change={(value) => change(["compat", "thinkingFormat"], value)} />}
		<AnimatePresence initial={false}>{templateKey && <Reveal key={templateKey} className="service-template-section">
			<ServiceTemplateParams label={templateKey} value={own[templateKey]} defaultValue={defaults[templateKey]}
				disabled={disabled} change={(path, value) => change(["compat", templateKey, ...path], value)} />
		</Reveal>}</AnimatePresence>
	</>;
}
