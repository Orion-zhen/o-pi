import path from "node:path";
import { fileURLToPath } from "node:url";

declare const OPI_PACKAGED: true;

/** 只有打包产物读取入口设置的资源目录。源码始终使用当前仓库。 */
export const binaryResourceDir = typeof OPI_PACKAGED === "undefined" ? undefined : process.env.PI_OPI_RESOURCE_DIR;

export function installationRoot(): string {
	return binaryResourceDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function defaultAgentConfigPath(fileName: string): string {
	return path.join(installationRoot(), "agent", "defaults", fileName);
}

export function agentSchemaPath(fileName: string): string {
	return path.join(installationRoot(), "agent", "schemas", fileName);
}
