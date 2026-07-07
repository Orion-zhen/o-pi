import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lspManager, registerLspCommands } from "../../src/lsp/index.js";

/** 注册 LSP 调试命令；LSP 只作为文件工具内部增强，不暴露模型工具。 */
export default function lspExtension(pi: ExtensionAPI): void {
	registerLspCommands(pi, lspManager);
}
