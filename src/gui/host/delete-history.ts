import path from "node:path";
import { lstat, realpath, unlink } from "node:fs/promises";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiAction, GuiSnapshot } from "../contract.ts";

export type DeleteHistoryAction = Extract<GuiAction, { action: "deleteSession" | "deleteWorkspace" }>;
type ActiveSession = Pick<GuiSnapshot, "cwd" | "sessionFile" | "name">;

/** 删除目标来自共享索引，不接受前端直接指定任意文件列表或目录递归删除。 */
export async function prepareHistoryDeletion(action: DeleteHistoryAction, active: ActiveSession | undefined) {
	const readTargets = async () =>
		(await SessionManager.listAll()).filter((session) =>
			action.action === "deleteSession" ? session.path === action.path : session.cwd === action.cwd,
		);
	const targets = await readTargets();
	const affectsCurrent = Boolean(
		active && (action.action === "deleteSession" ? active.sessionFile === action.path : active.cwd === action.cwd),
	);
	if (!targets.length && !affectsCurrent) throw new Error("历史记录已不存在，请刷新列表。");
	if (affectsCurrent && active?.sessionFile && !targets.some((session) => session.path === active.sessionFile)) {
		// 新会话在首次持久化前尚无文件，但外部 /resume 文件不能当作空会话删除。
		const exists = await lstat(active.sessionFile).then(
			() => true,
			(error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
				throw error;
			},
		);
		if (exists) throw new Error("当前会话不在共享历史目录中，不能通过此入口删除。");
	}
	const root = await realpath(path.join(getAgentDir(), "sessions"));
	const inspect = async (file: string) => {
		const parent = await realpath(path.dirname(file));
		const relative = path.relative(root, parent);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
			throw new Error("不能删除共享历史目录之外的文件。");
		const info = await lstat(file, { bigint: true });
		if (!info.isFile()) throw new Error("只允许删除普通会话文件，不允许符号链接。");
		return { parent, dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs };
	};
	const files = await Promise.all(
		targets.map(async (session) => ({ path: session.path, stamp: await inspect(session.path) })),
	);
	const title = action.action === "deleteWorkspace" ? "删除工作区" : "删除会话";
	const label =
		action.action === "deleteWorkspace"
			? action.cwd
			: targets[0]?.name || targets[0]?.firstMessage || active?.name || "新会话";
	return {
		affectsCurrent,
		title,
		message: `${label}\n\n将永久删除 ${files.length} 个共享历史会话，TUI 中的对应历史也会被删除。此操作无法撤销。\n不会删除项目目录、代码或配置。`,
		async verify() {
			const latest = await readTargets();
			if (latest.length !== files.length || latest.some((item) => !files.some((file) => file.path === item.path)))
				throw new Error("历史记录已变更，请重新确认删除。");
			for (const file of files) {
				const stamp = await inspect(file.path);
				if (
					stamp.parent !== file.stamp.parent ||
					stamp.dev !== file.stamp.dev ||
					stamp.ino !== file.stamp.ino ||
					stamp.size !== file.stamp.size ||
					stamp.mtime !== file.stamp.mtime ||
					stamp.ctime !== file.stamp.ctime
				)
					throw new Error("会话已被修改，请重新确认删除。");
			}
		},
		async remove() {
			for (const file of files) {
				// 关闭当前会话可追加关闭记录，因此此处只复核文件身份和目录边界。
				const stamp = await inspect(file.path);
				if (stamp.parent !== file.stamp.parent || stamp.dev !== file.stamp.dev || stamp.ino !== file.stamp.ino)
					throw new Error("会话文件已被替换，删除已停止。");
				await unlink(file.path);
			}
		},
	};
}
