import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
// SDK 包入口未导出日志工具，直接复用其解析、版本筛选和链接规范化逻辑。
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/changelog.js";
import type { GuiChangelog } from "../contract.ts";

/** 待展示日志由一个连接持有，断开或切换会话时归还，实际展示后才记为已读。 */
export class StartupChangelog {
	private pending: { owner: string; settings: SettingsManager } | undefined;

	async read(owner: string, cwd: string): Promise<GuiChangelog | null> {
		if (this.pending) return null;
		const settings = SettingsManager.create(cwd, undefined, { projectTrusted: false });
		checkSettings(settings);
		const lastVersion = settings.getLastChangelogVersion();
		if (!lastVersion) {
			await markSeen(settings);
			return null;
		}
		if (lastVersion === VERSION) return null;
		const entries = getNewEntries(parseChangelog(getChangelogPath()), lastVersion);
		if (!entries.length) return null;
		const value = {
			version: VERSION,
			markdown: entries.map((entry) => normalizeChangelogLinks(entry.content, entry)).join("\n\n"),
			collapsed: settings.getCollapseChangelog(),
		};
		this.pending = { owner, settings };
		return value;
	}

	async finish(owner: string, shown: boolean): Promise<void> {
		const pending = this.pending;
		if (pending?.owner !== owner) return;
		try { if (shown) await markSeen(pending.settings); }
		finally { if (this.pending === pending) this.pending = undefined; }
	}

	release(owner: string): void {
		if (this.pending?.owner === owner) this.pending = undefined;
	}
}

function checkSettings(settings: SettingsManager): void {
	const errors = settings.drainErrors();
	if (errors.length) throw new AggregateError(errors.map(({ error }) => error), "无法读写更新日志的已读版本。");
}

async function markSeen(settings: SettingsManager): Promise<void> {
	settings.setLastChangelogVersion(VERSION);
	await settings.flush();
	checkSettings(settings);
}
