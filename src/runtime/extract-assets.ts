import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EmbeddedAsset {
	readonly path: string;
	readonly source: string;
	readonly executable: boolean;
}

/** 先完整写入临时目录，再原子发布。并发启动只保留一个完整的资源目录。 */
export function extractAssets(id: string, assets: readonly EmbeddedAsset[]): string {
	const cache = path.join(os.homedir(), ".pi", "cache", "opi");
	const destination = path.join(cache, id);
	if (existsSync(destination)) return destination;
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	const staging = mkdtempSync(path.join(cache, ".extract-"));
	try {
		for (const asset of assets) {
			const file = path.join(staging, asset.path);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, readFileSync(asset.source), { mode: asset.executable ? 0o700 : 0o600 });
		}
		try {
			renameSync(staging, destination);
		} catch (error) {
			if (!(error instanceof Error && "code" in error
				&& (error.code === "EEXIST" || error.code === "ENOTEMPTY") && existsSync(destination))) throw error;
		}
		return destination;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
