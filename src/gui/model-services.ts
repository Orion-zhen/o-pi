import type { TSchema } from "typebox";
import type { ModelCandidate } from "../harness/openai-compatible-provider/model-candidates.ts";
import type { ServiceConnectionCheck } from "../harness/openai-compatible-provider/service-connection.ts";

export interface ModelServicesDocument {
	path: string;
	content: string;
	schema: TSchema;
}
export type ModelServiceConnection = ServiceConnectionCheck | { status: "unavailable" | "unconfigured" };

export interface ModelServiceCatalog {
	candidates: ModelCandidate[];
	connection: ModelServiceConnection;
	changes: "none" | "models" | "connection";
}
