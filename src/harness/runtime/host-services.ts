import type { Readable } from "node:stream";

export interface AgentProcess {
	stdout: Readable;
	stderr: Readable;
	exitCode: number | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null) => void): this;
}

export interface HostServices {
	spawnAgent(args: string[], cwd: string, env: NodeJS.ProcessEnv): AgentProcess;
	resolveProxy(url: string, signal?: AbortSignal): Promise<string>;
}

// 仅 Desktop 安装宿主能力，TUI/Web 保留原有运行时。
export let hostServices: HostServices | undefined;

export function setHostServices(services: HostServices): void {
	hostServices = services;
}
