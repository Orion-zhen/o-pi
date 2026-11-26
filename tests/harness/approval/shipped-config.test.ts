import path from "node:path";
import { it } from "vitest";
import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-shipped-approval-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");

it("随包审批配置能通过完整校验，不依赖用户覆盖", async () => {
	process.env.PI_APPROVAL_GATE_CONFIG = path.join(temp.path, "no-overrides.jsonc");
	await loadApprovalGateConfig();
});
