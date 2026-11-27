export type ShellName = "bash" | "powershell";

export const DEFAULT_SHELL_TOOL = process.platform === "win32" ? "powershell" : "bash";
export const SUPPORTED_SHELL_TOOLS: readonly ShellName[] = DEFAULT_SHELL_TOOL === "powershell" ? ["bash", "powershell"] : ["bash"];
