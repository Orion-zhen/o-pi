import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

export function changelogTests(context: () => { host: GuiClient; cwd: string; agentDir: string }) {
	const settings = async (): Promise<Settings> => JSON.parse(await readFile(path.join(context().agentDir, "settings.json"), "utf8"));
	const configure = async (value: Partial<Settings>) => {
		await writeFile(path.join(context().agentDir, "settings.json"), JSON.stringify({ ...await settings(), ...value }));
	};
	const versions = async () => {
		const text = await readFile(path.join(getPackageDir(), "CHANGELOG.md"), "utf8");
		const [current, previous, older] = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]);
		if (!current || !previous || !older) throw new Error("SDK 更新日志缺少版本条目。");
		expect(current).toBe(VERSION);
		return { current, previous, older };
	};

	describe("GUI 启动更新日志", () => {
		it("只启动后端不记录版本，首次打开界面仅建立基线", async () => {
			const { host } = context();
			expect((await settings()).lastChangelogVersion).toBeUndefined();
			expect(await host.query({ query: "startupChangelog" }, null)).toBeNull();
			expect((await settings()).lastChangelogVersion).toBe(VERSION);
			expect(await host.query({ query: "startupChangelog" }, null)).toBeNull();
		});

		it.each([false, true])("只返回新增日志，沿用折叠设置 %s，展示后持久化且不污染会话", async (collapsed) => {
			const { host, cwd } = context();
			const { current, previous, older } = await versions();
			await configure({ lastChangelogVersion: older, collapseChangelog: collapsed, quietStartup: true });
			const entries = host.runtime.session.sessionManager.getEntries();
			const messages = host.runtime.session.messages;
			const result = await host.query({ query: "startupChangelog" }, null);
			expect(result).toMatchObject({ version: current, collapsed });
			expect(result?.markdown).toContain(`## [${current}]`);
			expect(result?.markdown).toContain(`## [${previous}]`);
			expect(result?.markdown).not.toContain(`## [${older}]`);
			expect(result?.markdown).toContain(`/v${current}/packages/coding-agent/docs/`);
			expect((await settings()).lastChangelogVersion).toBe(older);
			// 模拟另一个 SDK 使用者修改配置，确认已读写入只合并自己的字段。
			const other = SettingsManager.create(cwd);
			other.setQuietStartup(false);
			await other.flush();
			await host.dispatch({ action: "startupChangelog", shown: true }, null);
			expect(await settings()).toMatchObject({ lastChangelogVersion: current, collapseChangelog: collapsed, quietStartup: false });
			expect(host.runtime.session.sessionManager.getEntries()).toEqual(entries);
			expect(host.runtime.session.messages).toEqual(messages);
			expect(await host.query({ query: "startupChangelog" }, null)).toBeNull();
			const restarted = new GuiHost();
			try {
				await restarted.start(cwd);
				expect(await restarted.createClient().query({ query: "startupChangelog" }, null)).toBeNull();
			} finally { await restarted.dispose(); }
		});

		it("多个连接只由一个展示，未展示就断开不会消耗日志", async () => {
			const { host } = context();
			await configure({ lastChangelogVersion: (await versions()).previous });
			const other = host.host.createClient();
			const results = await Promise.all([host.query({ query: "startupChangelog" }, null), other.query({ query: "startupChangelog" }, null)]);
			expect(results.filter(Boolean)).toHaveLength(1);
			host.close();
			const notice = await other.query({ query: "startupChangelog" }, null);
			expect(notice?.version).toBe(VERSION);
			await other.dispatch({ action: "startupChangelog", shown: true }, null);
			expect(await other.query({ query: "startupChangelog" }, null)).toBeNull();
		});

		it("查询后切换会话可以归还尚未展示的日志", async () => {
			const { host } = context();
			const { previous } = await versions();
			await configure({ lastChangelogVersion: previous });
			expect(await host.query({ query: "startupChangelog" }, null)).not.toBeNull();
			await host.dispatch({ action: "startupChangelog", shown: false }, null);
			expect((await settings()).lastChangelogVersion).toBe(previous);
			const other = host.host.createClient();
			expect(await other.query({ query: "startupChangelog" }, null)).not.toBeNull();
		});

		it("TUI 已记录版本或降级时不展示，也不回退已读版本", async () => {
			const { host, cwd } = context();
			for (const version of [VERSION, "999.0.0"]) {
				const tui = SettingsManager.create(cwd);
				tui.setLastChangelogVersion(version);
				await tui.flush();
				expect(await host.query({ query: "startupChangelog" }, null)).toBeNull();
				expect((await settings()).lastChangelogVersion).toBe(version);
			}
		});

		it("非法配置不被首次启动覆盖，修复后可正常读取", async () => {
			const { host, agentDir } = context();
			const file = path.join(agentDir, "settings.json");
			await writeFile(file, "{broken");
			await expect(host.query({ query: "startupChangelog" }, null)).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe("{broken");
			await writeFile(file, JSON.stringify({ lastChangelogVersion: (await versions()).previous }));
			expect(await host.query({ query: "startupChangelog" }, null)).not.toBeNull();
		});
	});
}
