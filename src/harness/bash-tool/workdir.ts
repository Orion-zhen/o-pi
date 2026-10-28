import path from "node:path";

/** 解析模型给出的工作目录，相对路径基于工作区根目录。 */
export function resolveBashWorkdir(workdir: string | undefined, workspace: string): string {
	return workdir === undefined || workdir.length === 0 ? workspace : path.resolve(workspace, workdir);
}
