import { isDeepStrictEqual } from "node:util";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsConfig } from "../../../harness/openai-compatible-provider/schema.ts";
import { parseModelsDocument } from "../../../harness/openai-compatible-provider/validation.ts";
import type { ModelServiceCatalog } from "../../model-services.ts";
import { readModelServices } from "../config/model-services.ts";

const authLabels = { stored: "已存凭证", runtime: "会话凭证", environment: "环境变量", fallback: "默认凭证", models_json_key: "配置密钥", models_json_command: "密钥命令" };

export async function readModelServiceCatalog(models: ModelRuntime, loaded: ModelsConfig | undefined, id: string): Promise<ModelServiceCatalog> {
	const document = await readModelServices();
	const saved = document.content === "" ? undefined : parseModelsDocument(document.content).providers[id];
	const reloadRequired = !isDeepStrictEqual(loaded?.source.providers[id], saved);
	const config = loaded?.providers[id];
	const native = models.getRegisteredNativeProvider(id);
	const discovery = config?.discoverModels === true && native?.refreshModels !== undefined;
	const auth = models.getProviderAuthStatus(id);
	// SDK 原始目录包含启动时的手动 ID，按已加载配置排除，不依赖编辑中的草稿。
	const manualIds = new Set(config?.models?.map((model) => model.id));
	const catalog = discovery ? native.getModels().filter((model) => !manualIds.has(model.id)) : [];
	return {
		auth: auth.source ? authLabels[auth.source] : auth.configured ? "已配置" : "未配置",
		reloadRequired,
		canRefresh: discovery && auth.configured && !reloadRequired,
		models: catalog.map(({ id, name, contextWindow, maxTokens, reasoning, input, api, thinkingLevelMap, compat }) =>
			({ id, name, contextWindow, maxTokens, reasoning, input: [...input], api, thinkingLevelMap, compat })),
	};
}

export async function refreshModelService(models: ModelRuntime, loaded: ModelsConfig | undefined, id: string, signal: AbortSignal): Promise<void> {
	const catalog = await readModelServiceCatalog(models, loaded, id);
	if (catalog.reloadRequired) throw new Error("请先重载当前会话，再刷新模型列表");
	if (!catalog.canRefresh) throw new Error("服务未启用自动发现或未配置认证");
	const result = await models.refresh({ providers: [id], allowNetwork: true, force: true,
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
	if (result.aborted) throw new Error("模型列表刷新已取消");
	if (result.errors.size) throw new Error("模型列表刷新失败");
}
