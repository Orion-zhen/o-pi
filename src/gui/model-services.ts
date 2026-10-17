import type { TSchema } from "typebox";
import type { ModelCandidate } from "../harness/openai-compatible-provider/model-candidates.ts";

export interface ModelServicesDocument {
	path: string;
	content: string;
	schema: TSchema;
}
export interface ModelServiceCatalog {
	candidates: ModelCandidate[];
	reloadRequired: boolean;
	error: string;
}
