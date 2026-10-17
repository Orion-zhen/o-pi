import { AnimatePresence } from "motion/react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { Query } from "../../contract.ts";
import type { ConfigObject } from "../../../harness/openai-compatible-provider/validation.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Reveal } from "../components/animated.tsx";
import { Switch } from "../components/ui/switch";
import { Disclosure } from "../components/disclosure.tsx";
import { SettingsRow } from "../settings/settings-controls.tsx";
import { apiChoices, ServiceBoolean, ServiceChoice, ServiceText } from "./service-fields.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { ServiceCompat } from "./service-compat.tsx";
import { ServiceModels } from "./service-models.tsx";
import { useServiceCatalog } from "./use-service-catalog.ts";

export function ServiceForm({ id, config, disabled, canRefresh, sessionId, savedContent, query, send, change }: {
	id: string; config: ConfigObject; disabled: boolean; canRefresh: boolean; sessionId: string | undefined;
	savedContent: string; query: Query; send: Send; change: ChangeConfig;
}) {
	const { value: catalog, status, error, refresh } = useServiceCatalog(id, sessionId, savedContent, query, send);
	const refreshing = status === "refreshing";
	const locked = disabled || refreshing;
	return <div className="service-form">
		{catalog?.reloadRequired && <span role="status" className="service-tag">待重载</span>}
		<div className="settings-fields">
			<ServiceText label="服务名称" value={config.name} disabled={locked} change={(value) => change(["name"], value)} />
			<ServiceText label="API 地址" value={config.baseUrl} required placeholder="http://localhost:8080/v1" disabled={locked} change={(value) => change(["baseUrl"], value)} />
			<ServiceChoice label="API 协议" value={config.api} required options={apiChoices} disabled={locked} change={(value) => change(["api"], value)} />
			<ServiceText label="API Key" value={config.apiKey} disabled={locked} change={(value) => change(["apiKey"], value)} />
			{sessionId && <SettingsRow label="当前认证"><span className="service-tag">{catalog?.auth ?? (error ? "读取失败" : "读取中…")}</span></SettingsRow>}
			<SettingsRow label="自动发现"><Switch aria-label="自动发现" disabled={locked} checked={config.discoverModels === true} onCheckedChange={(value) => change(["discoverModels"], value || undefined)} /></SettingsRow>
			<AnimatePresence initial={false}>{(config.discoverModels === true || config.modelsEndpoint !== undefined) && <Reveal key="endpoint"><ServiceText label="模型列表接口" value={config.modelsEndpoint} placeholder="models" disabled={locked} change={(value) => change(["modelsEndpoint"], value)} /></Reveal>}</AnimatePresence>
		</div>
		{config.discoverModels === true && <div className="service-catalog-actions">
			<span role="status">{refreshing ? "刷新中…" : status === "refreshed" ? "模型已刷新" : ""}</span>
			<Button size="sm" variant="outline" disabled={locked || !canRefresh || status === "loading" || !catalog?.canRefresh} onClick={refresh}>{refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}刷新模型</Button>
		</div>}
		{error && <p role="alert">{error}</p>}
		<ServiceModels provider={config} catalog={config.discoverModels === true ? catalog?.models ?? [] : []} disabled={locked} change={change} />
		<ServiceCompat config={config} api={config.api} disabled={locked} change={change} />
		<Disclosure className="service-disclosure" summary="请求设置" lazy><div className="settings-fields">
			<ServiceText label="请求超时（毫秒）" value={config.timeoutMs} numeric disabled={locked} change={(value) => change(["timeoutMs"], value)} />
			<ServiceText label="重试次数" value={config.maxRetries} numeric disabled={locked} change={(value) => change(["maxRetries"], value)} />
			<ServiceBoolean label="强制 Bearer 认证" value={config.authHeader} disabled={locked} change={(value) => change(["authHeader"], value)} />
		</div></Disclosure>
	</div>;
}
