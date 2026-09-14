import { configLayerFingerprint, resolveConfigLayerPaths, type ConfigDefinition } from "./config-loader.ts";

export interface ConfigSnapshot<T> {
	fingerprint: string;
	value: T;
}

/** 按配置文件快照缓存结果。同一快照的并发调用共用读取，每个调用方取得独立副本。 */
export class ConfigCache<T> {
	private entries = new Map<string, ConfigSnapshot<T>>();
	private readonly pending = new Map<string, Promise<ConfigSnapshot<T>>>();

	constructor(
		private readonly definition: ConfigDefinition,
		private readonly read: (cwd: string) => Promise<ConfigSnapshot<T>>,
	) {}

	async load(cwd: string): Promise<T> {
		const entries = this.entries;
		const paths = resolveConfigLayerPaths(this.definition, cwd);
		const key = paths.map((source) => source.path).join("\0");
		const fingerprint = await configLayerFingerprint(paths);
		const cached = entries.get(key);
		if (cached?.fingerprint === fingerprint) return structuredClone(cached.value);
		const pendingKey = `${key}\0${fingerprint}`;
		let pending = this.pending.get(pendingKey);
		if (pending === undefined) {
			pending = this.read(cwd);
			this.pending.set(pendingKey, pending);
		}
		try {
			const loaded = await pending;
			if (this.entries === entries) entries.set(key, loaded);
			return structuredClone(loaded.value);
		} finally {
			if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey);
		}
	}

	clear(): void {
		this.entries = new Map();
		this.pending.clear();
	}
}
