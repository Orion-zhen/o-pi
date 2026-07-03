import path from "node:path";

interface CachedReadVersion {
	version: string;
}

/** 记录模型已读取过的文件版本；key 使用 realpath，避免相对路径和符号链接绕过校验。 */
export class ReadVersionCache {
	private readonly versions = new Map<string, CachedReadVersion>();

	remember(realPath: string, version: string): void {
		this.versions.set(cacheKey(realPath), { version });
	}

	get(realPath: string): string | undefined {
		return this.versions.get(cacheKey(realPath))?.version;
	}

	forget(realPath: string): void {
		this.versions.delete(cacheKey(realPath));
	}
}

function cacheKey(realPath: string): string {
	const normalized = path.normalize(realPath);
	return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}
