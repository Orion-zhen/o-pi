import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_WARMING_MODES } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import { readSnapshot } from "../read-snapshot.ts";

export function settingsTests(context: () => { host: GuiClient; agentDir: string }) {
	describe("GUI 会话设置", () => {
		it.each(CACHE_WARMING_MODES)("缓存预热 %s 沿用 SDK 选项并写入全局配置，新会话恢复", async (mode) => {
			const { host, agentDir } = context();
			const file = path.join(agentDir, "settings.json");
			const before = JSON.parse(await readFile(file, "utf8"));
			const snapshot = readSnapshot(host);
			expect(snapshot.cacheWarmingModes).toEqual(CACHE_WARMING_MODES);
			expect(snapshot.settings.cacheWarming).toBe(host.runtime.services.settingsManager.getCacheWarmingMode());
			await host.dispatch({ action: "settings", ...snapshot.settings, cacheWarming: mode });
			expect(readSnapshot(host).settings.cacheWarming).toBe(mode);
			expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ ...before, cacheWarming: mode });
			await host.dispatch({ action: "new" });
			expect(readSnapshot(host).settings.cacheWarming).toBe(mode);
		});

		it("保存前拒绝 SDK 不支持的预热模式，不改写配置", async () => {
			const { host, agentDir } = context();
			const file = path.join(agentDir, "settings.json");
			const before = await readFile(file, "utf8");
			await expect(host.dispatch({ action: "settings", ...readSnapshot(host).settings, cacheWarming: "unsupported" })).rejects.toThrow("无效 GUI 操作参数");
			expect(await readFile(file, "utf8")).toBe(before);
		});
	});
}
