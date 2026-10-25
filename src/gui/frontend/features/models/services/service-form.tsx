import { LoaderCircle, RefreshCw } from "lucide";
import { MorphIcon } from "morphicons/react";
import { editModelsDocument } from "../../../../../harness/openai-compatible-provider/config-edits.ts";
import { serviceCompatSettings } from "../../../../../harness/openai-compatible-provider/compat-settings.ts";
import type { ConfigObject } from "../../../../../harness/openai-compatible-provider/document.ts";
import { Button } from "@/ui/button.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { apiChoices, ServiceBoolean, ServiceChoice, ServiceNumber, ServiceText } from "./service-fields.tsx";
import type { ChangeConfig, ChangeDraft } from "./service-draft.ts";
import { ServiceCompat } from "./service-compat.tsx";
import { ServiceThinkingFormat } from "./service-thinking-format.tsx";
import { ServiceModels } from "./service-models.tsx";
import type { ServiceCatalogState } from "./use-service-catalog.ts";

interface ServiceFormProps {
	id: string;
	config: ConfigObject;
	disabled: boolean;
	catalog: ServiceCatalogState;
	status: string;
	changeDraft: ChangeDraft;
}

export function ServiceForm({ id, config, disabled, catalog: state, status, changeDraft }: ServiceFormProps) {
	const { value: catalog, canRetry, retry } = state;
	const loading = state.phase === "loading";
	const candidates = catalog?.candidates ?? [];
	const compat = serviceCompatSettings(id, config);
	const change: ChangeConfig = (path, value) => {
		changeDraft((current) => editModelsDocument(current, ["providers", id, ...path], value));
	};

	return <div className="service-form">
		{catalog?.changes === "models" && <span role="status" className="service-tag">待重载</span>}
		<div className="settings-fields">
			<ServiceText label="服务名称" value={config.name} defaultValue={id} placeholder={id}
				disabled={disabled} change={(value) => change(["name"], value)} />
			<ServiceText label="API 地址" value={config.baseUrl} required placeholder="http://localhost:8080/v1"
				disabled={disabled} change={(value) => change(["baseUrl"], value)} />
			<ServiceChoice label="API 协议" value={config.api} required options={apiChoices}
				disabled={disabled} change={(value) => change(["api"], value)} />
			<ServiceText label="API Key" value={config.apiKey} disabled={disabled} change={(value) => change(["apiKey"], value)} />
			<ServiceThinkingFormat settings={compat} disabled={disabled} change={change} />
		</div>
		<ServiceCompat settings={compat} disabled={disabled} change={change} />
		<Disclosure className="service-disclosure" summary="请求设置" lazy><div className="settings-fields">
			<ServiceNumber label="请求超时（毫秒）" value={config.timeoutMs} disabled={disabled} change={(value) => change(["timeoutMs"], value)} />
			<ServiceNumber label="重试次数" value={config.maxRetries} disabled={disabled} change={(value) => change(["maxRetries"], value)} />
			<ServiceBoolean label="强制 Bearer 认证" value={config.authHeader} defaultValue={false}
				disabled={disabled} change={(value) => change(["authHeader"], value)} />
		</div></Disclosure>
		<ServiceModels providerId={id} provider={config} candidates={candidates} disabled={disabled} change={change} status={status}
			actions={<Button size="sm" variant="outline" disabled={!canRetry} onClick={retry}>
				<MorphIcon icon={loading ? LoaderCircle : RefreshCw} spring="smooth" size="1em" className={loading ? "animate-spin" : undefined} />重新获取
			</Button>} />
	</div>;
}
