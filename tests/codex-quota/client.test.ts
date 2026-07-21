import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCodexQuotaSnapshot, parseCodexQuotaSnapshot } from "../../src/codex-quota/client.js";
import { CodexQuotaError } from "../../src/codex-quota/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("codex-quota-");

describe("codex quota client", () => {
	it("解析 app-server 的窗口和重置卡详情", () => {
		const snapshot = parseCodexQuotaSnapshot(
			{
				rateLimits: { limitId: "codex", primary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: 1_783_296_000 } },
				rateLimitsByLimitId: {
					codex: {
						limitId: "codex",
						limitName: "Codex",
						planType: "pro",
						primary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: 1_783_296_000 },
						credits: { hasCredits: true, unlimited: false, balance: "10" },
					},
				},
				rateLimitResetCredits: {
					availableCount: 1,
					credits: [{ id: "credit-1", resetType: "codexRateLimits", status: "available", grantedAt: 1_783_209_600, expiresAt: null, title: "Full reset", description: "Free reset" }],
				},
			},
			new Date("2026-07-06T00:00:00Z"),
		);

		expect(snapshot.buckets[0]?.primary?.usedPercent).toBe(75);
		expect(snapshot.buckets[0]?.primary?.resetsAt?.toISOString()).toBe("2026-07-06T00:00:00.000Z");
		expect(snapshot.resetCredits?.credits?.[0]?.expiresAt).toBeUndefined();
		expect(snapshot.resetCredits?.credits?.[0]?.description).toBe("Free reset");
	});

	it.each([{}, { rateLimits: {}, rateLimitResetCredits: { availableCount: "bad" } }])("拒绝无效响应 %#", (value) => {
		try {
			parseCodexQuotaSnapshot(value);
			expect.fail("expected an error");
		} catch (error) {
			expect(error).toBeInstanceOf(CodexQuotaError);
			expect((error as CodexQuotaError).code).toBe("unexpected_response");
		}
	});

	it("通过 app-server 完成 initialize 和额度查询，并在结束后关闭进程", async () => {
		const command = join(temp.path, "fake-codex");
		await writeFile(command, fakeServerScript(), "utf8");
		await chmod(command, 0o755);

		const snapshot = await collectCodexQuotaSnapshot({ command, timeoutMs: 5_000, now: new Date("2026-07-06T00:00:00Z") });
		expect(snapshot.buckets[0]?.id).toBe("codex");
		expect(snapshot.resetCredits?.availableCount).toBe(1);
	});

	it("区分超时和外部取消", async () => {
		const command = join(temp.path, "hang-codex");
		await writeFile(command, "#!/usr/bin/env node\nprocess.stdin.on('data', () => {});", "utf8");
		await chmod(command, 0o755);
		await expect(collectCodexQuotaSnapshot({ command, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });

		const controller = new AbortController();
		const pending = collectCodexQuotaSnapshot({ command, timeoutMs: 5_000, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});

	it("将找不到命令转换为脱敏错误", async () => {
		await expect(collectCodexQuotaSnapshot({ command: join(temp.path, "missing-codex"), timeoutMs: 1_000 })).rejects.toMatchObject({ code: "command_not_found" });
	});
});

function fakeServerScript(): string {
	return `#!/usr/bin/env node
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const result = request.method === "initialize"
      ? { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" }
      : { rateLimits: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1783296000 } }, rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: 1, credits: [] } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});`;
}
