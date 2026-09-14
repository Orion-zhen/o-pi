import path from "node:path";
import { fileURLToPath } from "node:url";

/** 二进制入口在加载业务模块前设置资源目录，worker 和子进程继承此值。 */
export const binaryResourceDir = process.env.PI_OPI_RESOURCE_DIR;

export function installationRoot(): string {
	return binaryResourceDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}
