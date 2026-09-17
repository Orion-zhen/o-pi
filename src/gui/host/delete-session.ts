import { lstat, unlink } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { inspectHistoryFile } from "./history-file.ts";

const historyPaths = async () => new Set((await SessionManager.listAll()).map((session) => session.path));

// 整批验证后再删除，未持久化的当前会话只需切换到新会话。
export async function prepareSessionDeletion(files: string[], currentFile: string | null) {
	const indexed = await historyPaths();
	const targets: { file: string; stamp: Awaited<ReturnType<typeof inspectHistoryFile>> }[] = [];
	for (const file of files) {
		if (indexed.has(file)) {
			targets.push({ file, stamp: await inspectHistoryFile(file) });
			continue;
		}
		if (file !== currentFile) throw new Error("历史记录已不存在，请刷新列表。");
		const exists = await lstat(file).then(
			() => true,
			(error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
				throw error;
			},
		);
		if (exists) throw new Error("当前会话不在共享历史目录中，不能通过此入口删除。");
	}
	return {
		affectsCurrent: currentFile !== null && files.includes(currentFile),
		async verify() {
			const latestPaths = await historyPaths();
			if (files.some((file) => indexed.has(file) !== latestPaths.has(file)))
				throw new Error("历史记录已变更，请重新确认删除。");
			for (const { file, stamp } of targets) {
				const latest = await inspectHistoryFile(file);
				if (latest.parent !== stamp.parent || latest.dev !== stamp.dev || latest.ino !== stamp.ino ||
					latest.size !== stamp.size || latest.mtime !== stamp.mtime || latest.ctime !== stamp.ctime)
					throw new Error("会话已被修改，请重新确认删除。");
			}
		},
		async remove() {
			for (const { file, stamp } of targets) {
				// 关闭当前会话可追加记录，此处只复核文件身份和目录边界。
				const latest = await inspectHistoryFile(file);
				if (latest.parent !== stamp.parent || latest.dev !== stamp.dev || latest.ino !== stamp.ino)
					throw new Error("会话文件已被替换，删除已停止。");
				await unlink(file);
			}
		},
	};
}
