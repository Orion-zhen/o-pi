import { ChevronRight } from "lucide-react";
import { editModelsDocument } from "../../../../../harness/model-services/config-edits.ts";
import type { ConfigObject } from "../../../../../harness/model-services/document.ts";
import { serviceConnectionKey } from "../../../../../harness/model-services/service-connection.ts";
import { Button } from "@/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { ConfirmAction } from "@/ui/confirm-action.tsx";
import { Reveal } from "@/ui/motion/animated.tsx";
import { ServiceForm } from "./service-form.tsx";
import type { ChangeDraft } from "./service-draft.ts";
import { textValue } from "./service-fields.tsx";
import { ServiceConnectionBadge, type ServiceConnectionState } from "./service-connection-badge.tsx";
import { useServiceCatalog, type CatalogQuery, type ServiceCatalogState } from "./use-service-catalog.ts";

function serviceAddress(value: unknown): string {
	if (typeof value !== "string") return "";
	try { return new URL(value).host; } catch { return ""; }
}

function catalogMessage({ phase, value }: ServiceCatalogState): string {
	const failed = "获取候选模型失败，可重试或手动填写模型 ID";
	if (phase === "loading") return "获取候选模型…";
	if (phase === "failed") return failed;
	if (!value) return "";
	switch (value.connection.status) {
		case "connected": return "";
		case "catalog": return "候选来自 Pi SDK 目录，未验证服务连接";
		case "unsupported": return "不支持当前协议的远端模型查询，可手动填写模型 ID";
		case "unavailable": return value.changes === "connection" ? "请先保存并重载新服务，再获取候选模型" : "";
		case "unconfigured": return "请先配置认证，也可直接手动填写模型 ID";
		default: return failed;
	}
}

interface ServiceItemProps {
	id: string;
	config: ConfigObject;
	disabled: boolean;
	open: boolean;
	setOpen: (open: boolean) => void;
	savedConfig: ConfigObject | undefined;
	sessionId: string | undefined;
	sessionRevision: number | undefined;
	sessionReady: boolean;
	query: CatalogQuery;
	changeDraft: ChangeDraft;
}

export function ServiceItem({ id, config, disabled, open, setOpen, savedConfig, sessionId, sessionRevision, sessionReady, query, changeDraft }: ServiceItemProps) {
	const connectionDirty = serviceConnectionKey(config) !== serviceConnectionKey(savedConfig);
	const catalog = useServiceCatalog({ id, sessionId, revision: sessionRevision, savedContent: JSON.stringify(savedConfig ?? null),
		enabled: !connectionDirty, ready: sessionReady && !disabled, query });
	const connection: ServiceConnectionState = !sessionId ? { status: "unchecked" } : connectionDirty ? { status: "unsaved" }
		: catalog.phase === "loading" ? { status: "checking" }
		: catalog.value?.changes === "connection" ? { status: "reload-required" }
		: catalog.value?.connection ?? { status: catalog.phase === "failed" ? "check-failed" : "unchecked" };
	const status = !sessionId ? "选择会话后获取候选模型"
		: connectionDirty ? "请先保存并重载连接配置，再获取候选模型" : catalogMessage(catalog);
	const name = textValue(config.name) || id;
	const address = serviceAddress(config.baseUrl);
	const remove = async () => changeDraft((current) => editModelsDocument(current, ["providers", id], undefined));

	return <Reveal><Collapsible open={open} onOpenChange={setOpen} asChild>
		<article className="model-service" aria-label={`模型服务 ${id}`}>
			<div className="service-item-heading">
				<CollapsibleTrigger className="service-summary" aria-label={`编辑服务 ${id}`}>
					<strong className="service-summary-line">{name}{name !== id && <span>{id}</span>}</strong>
					<span className="service-summary-line">
						{address && <><span>{address}</span><span>·</span></>}
						<span>{textValue(config.api) || "API 未设置"}</span>
					</span>
				</CollapsibleTrigger>
				<ServiceConnectionBadge id={id} connection={connection} retry={catalog.retry}
					disabled={!catalog.canRetry} />
				<div className="service-item-actions">
					<ConfirmAction label={`删除服务 ${id}`} disabled={disabled} confirm={remove} />
					<CollapsibleTrigger className="disclosure-trigger" asChild>
						<Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"}服务 ${id}`}>
							<ChevronRight className="disclosure-chevron" />
						</Button>
					</CollapsibleTrigger>
				</div>
			</div>
			<CollapsibleContent lazy><ServiceForm id={id} config={config} disabled={disabled}
				catalog={catalog} status={status} changeDraft={changeDraft} /></CollapsibleContent>
		</article>
	</Collapsible></Reveal>;
}
