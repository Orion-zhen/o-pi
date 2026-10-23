import type { EditDiffResult } from "@earendil-works/pi-coding-agent";

/** 生产环境直接使用 SDK 差异函数，测试可在准备阶段控制竞态。 */
export type TextDiffGenerator = (before: string, after: string) => EditDiffResult | Promise<EditDiffResult>;
