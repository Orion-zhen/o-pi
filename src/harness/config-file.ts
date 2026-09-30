import { mkdir, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function replaceConfigFile(target: string, original: string, content: string): Promise<void> {
	await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		// 在同一个同步片段中检查版本并原子替换，拒绝覆盖读取后的修改。
		let current: string;
		try {
			current = readFileSync(target, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") current = "";
			else throw error;
		}
		if (current !== original) throw new Error("设置文件已被修改，请重新打开后编辑。");
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}
