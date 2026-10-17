import { isDeepStrictEqual } from "node:util";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsConfig } from "../../../harness/openai-compatible-provider/schema.ts";
import { isCompatibleService, parseModelsDocument } from "../../../harness/openai-compatible-provider/document.ts";
import type { ModelServiceCatalog } from "../../model-services.ts";
import { readModelServices } from "../config/model-services.ts";
import { fetchModelCandidates } from "../../../harness/openai-compatible-provider/fetch-candidates.ts";

export async function readModelServiceCatalog(models: ModelRuntime, loaded: ModelsConfig | undefined, id: string, signal: AbortSignal): Promise<ModelServiceCatalog> {
	const document = await readModelServices();
	const saved = document.content === "" ? undefined : parseModelsDocument(document.content).providers[id];
	const config = loaded?.source.providers[id];
	const reloadRequired = !isDeepStrictEqual(config, saved);
	const auth = models.getProviderAuthStatus(id);
	const result: ModelServiceCatalog = {
		reloadRequired, candidates: [], error: "",
	};
	if (!config) return { ...result, error: "请先保存并重载新服务，再获取候选模型" };
	if (!isCompatibleService(config) || typeof config.baseUrl !== "string") return result;
	if (!auth.configured) return { ...result, error: "请先配置认证，也可直接手动填写模型 ID" };
	try {
		result.candidates = await fetchModelCandidates(models, id, config.baseUrl, signal);
	} catch {
		// 认证和上游错误可能含密钥或响应正文，只向 UI 返回操作提示。
		result.error = "获取候选模型失败，可重试或手动填写模型 ID";
	}
	return result;
}
