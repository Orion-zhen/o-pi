import type { TSchema } from "typebox";
import type { ModelCandidate } from "../../../harness/model-services/model-candidates.ts";
import type { ServiceConnectionCheck } from "../../../harness/model-services/service-connection.ts";

export interface ModelServicesDocument {
	path: string;
	content: string;
	schema: TSchema;
	apis: string[];
}
export type ModelServiceConnection = ServiceConnectionCheck | { status: "unavailable" | "unconfigured" };

export interface ModelServiceCatalog {
	candidates: ModelCandidate[];
	connection: ModelServiceConnection;
	changes: "none" | "models" | "connection";
}
