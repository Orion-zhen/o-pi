import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import { takeProgramResumeToken } from "@earendil-works/pi-tui";

// SDK 的恢复命令启动 pi 而非 opi。不注册该命令，也不向子进程传递令牌。
takeProgramResumeToken();
process.env.PI_CODING_AGENT = "true";
process.env.PI_CACHE_RETENTION ??= "long";
process.env.AI_AGENT = "pi";
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
