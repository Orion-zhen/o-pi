import path from "node:path";
import os from "node:os";
import { lstat } from "node:fs/promises";
import { getAgentDir, getSessionsDir, getDebugLogPath } from "../../../harness/storage/sdk-paths.ts";
import { bashOutputDirectory, exportDirectoryPrefix, forkDirectoryPrefix, resourceCacheDirectory, telemetryReportDirectory, telemetryRunsDirectory, userHistoryPath } from "../../../harness/storage/paths.ts";
import type { StorageSourceId } from "../../storage.ts";
import type { GuiHost } from "../host.ts";
import { missingStorage, storageChildren } from "./files.ts";

export interface StorageCandidate { root: string; file: string; name: string }
export interface StorageSource {
	id: StorageSourceId;
	title: string;
	paths: string[];
	candidates: () => Promise<StorageCandidate[]>;
}
const candidate = (root: string, file: string, name = path.basename(file)): StorageCandidate => ({ root, file, name });
const children = async (root: string, accept: (name: string) => boolean) => (await storageChildren(root, accept)).map((file) => candidate(root, file));

export function storageSources(host: GuiHost): StorageSource[] {
	const history = userHistoryPath();
	const runs = telemetryRunsDirectory();
	const report = telemetryReportDirectory();
	const resources = resourceCacheDirectory();
	const bash = bashOutputDirectory();
	const temporary = os.tmpdir();
	const prefixes = [forkDirectoryPrefix(), exportDirectoryPrefix()];
	const agent = getAgentDir();
	return [
		{
			id: "sessions", title: "会话历史",
			paths: [getSessionsDir()], async candidates() {
				return (await host.catalog.read()).map((entry) => candidate(getSessionsDir(), entry.path, entry.title));
			},
		},
		{
			id: "input", title: "输入历史",
			paths: [history], candidates: async () => [candidate(path.dirname(history), history, "历史输入")],
		},
		{
			id: "telemetry", title: "本地遥测",
			paths: [runs], candidates: () => children(runs, (name) => name.endsWith(".jsonl")),
		},
		{
			id: "reports", title: "离线报告",
			paths: [report], candidates: async () => [candidate(path.dirname(report), report, "最近一次离线报告")],
		},
		{
			id: "resources", title: "程序资源缓存",
			paths: [resources], candidates: () => children(resources, (name) => /^[a-f\d]{64}$/u.test(name)),
		},
		{
			id: "temporary", title: "工具输出与临时文件",
			paths: [...new Set([bash, temporary, ...prefixes.map((prefix) => path.dirname(prefix))])],
			async candidates() {
				const result: StorageCandidate[] = [];
				for (const directory of await storageChildren(bash, () => true)) {
					try { if (!(await lstat(directory)).isDirectory()) continue; }
					catch (error) { if (missingStorage(error)) continue; throw error; }
					for (const file of await storageChildren(directory, (name) => name.endsWith(".log"))) result.push(candidate(bash, file));
				}
				for (const prefix of prefixes) result.push(...await children(path.dirname(prefix), (name) => name.startsWith(path.basename(prefix))));
				// SDK 暂未提供输出文件的枚举接口，只识别其生成的随机文件名。
				result.push(...await children(temporary, (name) => /^pi-(?:bash-[a-f\d]{16}\.log|codemode-[a-f\d]{16}\.txt|mcp-[a-f\d]{16}(?:\.[\w-]+)?|clipboard-[a-f\d-]{36}\.[\w]+)$/u.test(name)));
				return result;
			},
		},
		{
			id: "logs", title: "SDK 日志",
			paths: [agent], candidates: async () => ["mcp.log", "mcp.log.1", "crashes.json"].map((name) => candidate(agent, path.join(agent, name)))
				.concat(candidate(path.dirname(getDebugLogPath()), getDebugLogPath())),
		},
	];
}
