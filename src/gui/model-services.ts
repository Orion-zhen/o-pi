import type { TSchema } from "typebox";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ConfigObject } from "../harness/openai-compatible-provider/validation.ts";

export interface ModelServicesDocument {
	path: string;
	content: string;
	schema: TSchema;
}
export interface ServiceModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	api?: Api;
	thinkingLevelMap?: ThinkingLevelMap | undefined;
	compat?: Model<Api>["compat"];
}
export interface ModelServiceCatalog {
	models: ServiceModel[];
	auth: string;
	reloadRequired: boolean;
	canRefresh: boolean;
}
export function isCompatibleService(provider: ConfigObject): boolean {
	return provider.api === "openai-completions" || provider.api === "openai-responses";
}
