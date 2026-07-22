import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type SubagentMode = "parallel" | "chain";
export type SubagentSource = "user" | "project";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextTokens: number;
	cost?: number;
	turns: number;
}

export interface AgentOverride {
	model?: string;
	tools?: string[];
}

export interface SubagentConfig {
	defaultModel?: string;
	maxParallelTasks: number;
	maxConcurrency: number;
	timeoutMs: number;
	retries: number;
	retryDelayMs: number;
	retryOnEmptyOutput: boolean;
	retryOnTimeout: boolean;
	maxInlineOutputTokens: number;
	maxHandoffTokens: number;
	agentScope: "user";
	allowProjectAgents: boolean;
	projectAgentsOverrideUser: boolean;
	confirmWriteAgents: boolean;
	defaultTools: string[];
	agentOverrides: Record<string, AgentOverride>;
}

export interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	tools: string[];
	timeoutMs?: number;
	retries?: number;
	autoConfirm?: boolean;
	source: SubagentSource;
	filePath: string;
	hasWriteCapability: boolean;
}

export interface AgentDiscovery {
	agents: AgentDefinition[];
	warnings: string[];
	userAgentsDir: string;
	projectAgentsDir?: string;
}

export interface SubagentTask {
	agent: string;
	task: string;
	cwd?: string;
}

export interface SubagentToolParams {
	tasks: SubagentTask[];
}

export interface SubagentRunResult {
	runId: string;
	mode: SubagentMode;
	agent: string;
	source: SubagentSource;
	task: string;
	cwd: string;
	model?: string;
	tools: string[];
	attempts: number;
	exitCode: number;
	stopReason?: string;
	error?: string;
	output?: string;
	outputFile?: string;
	stderr?: string;
	durationMs: number;
	usage: UsageStats;
	events: RenderEvent[];
}

export interface SubagentDetails {
	mode: SubagentMode;
	runId: string;
	tasks: SubagentTask[];
	results: SubagentRunResult[];
	warnings: string[];
}

export type SubagentToolResult = AgentToolResult<SubagentDetails>;

export type RenderEvent =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };

export interface ProcessRunInput {
	runId: string;
	mode: SubagentMode;
	agent: AgentDefinition;
	task: string;
	cwd: string;
	model?: string;
	tools: string[];
	timeoutMs: number;
	attempt: number;
	maxAttempts: number;
}

export interface ProcessRunOutput {
	exitCode: number;
	stopReason?: string;
	error?: string;
	output: string;
	stderr: string;
	usage: UsageStats;
	events: RenderEvent[];
	durationMs: number;
	timedOut: boolean;
	aborted: boolean;
	providerError?: string;
	parseErrors: number;
	wrote: boolean;
}

export interface ProcessRunProgress {
	output: string;
	stderr: string;
	usage: UsageStats;
	events: RenderEvent[];
	durationMs: number;
	stopReason?: string;
	error?: string;
	parseErrors: number;
	wrote: boolean;
}

export interface ExecutorContext {
	cwd: string;
	hasUI: boolean;
	currentModel?: string | undefined;
	registeredTools?: string[] | undefined;
	signal?: AbortSignal | undefined;
	confirm?: ((title: string, message: string) => Promise<boolean>) | undefined;
	onUpdate?: ((partial: SubagentToolResult) => void) | undefined;
}

export interface ExecutorOptions {
	failFast?: boolean;
}
