import os from "node:os";
import path from "node:path";

// 解包入口也使用这些路径，不能提前加载依赖解包资源的 SDK。
const storageDirectory = () => path.join(os.homedir(), ".pi");
const userCacheDirectory = () => path.join(storageDirectory(), "cache");
export const resourceCacheDirectory = () => path.join(userCacheDirectory(), "opi");
export const userHistoryPath = () => path.join(userCacheDirectory(), "user-history", "history.jsonl");
export const telemetryRunsDirectory = () => path.join(storageDirectory(), "telemetry", "runs");
export const telemetryReportDirectory = () => path.join(storageDirectory(), "telemetry", "reports", "latest");
export const bashOutputDirectory = () => path.join(os.tmpdir(), "o-pi", "bash");
export const forkDirectoryPrefix = () => path.join(os.tmpdir(), "pi-subagent-fork-");
export const exportDirectoryPrefix = () => path.join(os.tmpdir(), "opi-export-");
