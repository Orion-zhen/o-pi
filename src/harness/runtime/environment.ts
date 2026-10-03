import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

process.env.PI_CODING_AGENT = "true";
process.env.PI_TELEMETRY = "0";
process.env.AI_AGENT = "pi";
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
