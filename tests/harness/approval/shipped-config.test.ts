import path from "node:path";
import { expect, it } from "vitest";
import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-shipped-approval-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");

it("未提供用户覆盖时可以加载随包审批配置", async () => {
	process.env.PI_APPROVAL_GATE_CONFIG = path.join(temp.path, "missing.jsonc");
	await expect(loadApprovalGateConfig()).resolves.toBeDefined();
});
