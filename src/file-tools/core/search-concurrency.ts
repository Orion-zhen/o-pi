import { availableParallelism } from "node:os";

/** 文件搜索默认并发路数：逻辑核心数的一半，单核环境至少保留一路。 */
export const FILE_SEARCH_CONCURRENCY = Math.max(1, Math.floor(availableParallelism() / 2));
