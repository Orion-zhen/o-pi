import { isDeepStrictEqual } from "node:util";
import pLimit from "p-limit";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsConfig } from "../../../harness/openai-compatible-provider/schema.ts";
import { isCompatibleService, parseModelsDocument } from "../../../harness/openai-compatible-provider/document.ts";
import { serviceConnectionKey } from "../../../harness/openai-compatible-provider/service-connection.ts";
import type { ModelServiceCatalog } from "../../shared/config/model-services.ts";
import { readModelServices } from "../config/model-services.ts";
import { fetchModelCandidates } from "../../../harness/openai-compatible-provider/fetch-candidates.ts";

async function readCatalog(models: ModelRuntime, loaded: ModelsConfig | undefined, id: string, signal: AbortSignal): Promise<ModelServiceCatalog> {
	const document = await readModelServices();
	const saved = document.content === "" ? undefined : parseModelsDocument(document.content).providers[id];
	const config = loaded?.source.providers[id];
	const changes = serviceConnectionKey(config) !== serviceConnectionKey(saved) ? "connection"
		: isDeepStrictEqual(config, saved) ? "none" : "models";
	if (!config || !isCompatibleService(config) || typeof config.baseUrl !== "string") {
		return { changes, candidates: [], connection: { status: "unavailable" } };
	}
	if (!models.getProviderAuthStatus(id).configured) {
		return { changes, candidates: [], connection: { status: "unconfigured" } };
	}
	return { changes, ...await fetchModelCandidates(models, id, config.baseUrl, signal) };
}

/** 会话重载使排队中和进行中的检测失效，所有客户端共用并发上限。 */
export class GuiModelServices {
	private loaded: ModelsConfig | undefined;
	private controller = new AbortController();
	private requests = pLimit(3);
	revision = 0;

	bind(config: ModelsConfig | undefined): void {
		this.controller.abort();
		this.controller = new AbortController();
		this.loaded = config;
		this.revision++;
	}

	read(models: ModelRuntime, id: string, parentSignal: AbortSignal): Promise<ModelServiceCatalog> {
		const signal = AbortSignal.any([parentSignal, this.controller.signal]);
		const loaded = this.loaded;
		return this.requests(() => {
			signal.throwIfAborted();
			return readCatalog(models, loaded, id, signal);
		});
	}
}
