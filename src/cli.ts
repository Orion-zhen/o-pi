#!/usr/bin/env node
import { main, parseArgs } from "@earendil-works/pi-coding-agent";

// 与 Pi CLI 保持相同的进程环境和警告策略，HTTP 初始化由 main 负责。
process.title = "opi";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

const args = process.argv.slice(2);
const { noExtensions } = parseArgs(args);
const extensionFactories = noExtensions ? [] : (await import("./extensions.js")).extensions;
await main(args, { extensionFactories });
