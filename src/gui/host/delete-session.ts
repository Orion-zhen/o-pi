import { lstat, unlink } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { inspectHistoryFile } from "./history-file.ts";

// 只删除共享索引中的会话，未持久化的当前会话只需切换到新会话。
export async function prepareSessionDeletion(file: string, currentFile: string | null) {
	const findTarget = async () => (await SessionManager.listAll()).find((session) => session.path === file);
	const target = await findTarget();
	const affectsCurrent = currentFile === file;
	if (!target && !affectsCurrent) throw new Error("历史记录已不存在，请刷新列表。");
	if (!target && affectsCurrent) {
		const exists = await lstat(file).then(
			() => true,
			(error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
				throw error;
			},
		);
		if (exists) throw new Error("当前会话不在共享历史目录中，不能通过此入口删除。");
	}
	const stamp = target ? await inspectHistoryFile(file) : undefined;
	return {
		affectsCurrent,
		async verify() {
			if (Boolean(await findTarget()) !== Boolean(target)) throw new Error("历史记录已变更，请重新确认删除。");
			if (!stamp) return;
			const latest = await inspectHistoryFile(file);
			if (latest.parent !== stamp.parent || latest.dev !== stamp.dev || latest.ino !== stamp.ino ||
				latest.size !== stamp.size || latest.mtime !== stamp.mtime || latest.ctime !== stamp.ctime)
				throw new Error("会话已被修改，请重新确认删除。");
		},
		async remove() {
			if (!stamp) return;
			// 关闭当前会话可追加记录，此处只复核文件身份和目录边界。
			const latest = await inspectHistoryFile(file);
			if (latest.parent !== stamp.parent || latest.dev !== stamp.dev || latest.ino !== stamp.ino)
				throw new Error("会话文件已被替换，删除已停止。");
			await unlink(file);
		},
	};
}
