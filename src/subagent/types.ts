import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	SessionEntry,
	ToolInfo as PiToolInfo,
} from "@earendil-works/pi-coding-agent";

export type SubagentMode = "parallel" | "chain";
export type SubagentSource = "user" | "project";
export type ContextMode = "isolated" | "fork";
export type ParentModel = Model<Api>;
export type ToolInfo = PiToolInfo;
export type NonEmptyArray<T> = [T, ...T[]];

export interface ParentSessionManager {
	getSessionId(): string;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntries(): SessionEntry[];
}

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
	maxInlineOutputTokens: number;
	maxHandoffTokens: number;
	allowProjectAgents: boolean;
	projectAgentsOverrideUser: boolean;
	confirmWriteAgents: boolean;
	defaultTools: string[];
	agentOverrides: Record<string, AgentOverride>;
}

export interface AgentDefinition {
	name: string;
	description: string;
	body: string;
	fork: boolean;
	model?: string;
	tools: string[];
	timeoutMs?: number;
	autoConfirm?: boolean;
	source: SubagentSource;
	filePath: string;
}

export interface AgentDiscovery {
	agents: AgentDefinition[];
	warnings: string[];
}

export interface SubagentTask {
	agent: string;
	task: string;
	cwd?: string;
}

export interface SubagentToolParams {
	tasks: NonEmptyArray<SubagentTask>;
}

interface SubagentRunBase {
	runId: string;
	mode: SubagentMode;
	contextMode: ContextMode;
	agent: string;
	source: SubagentSource;
	task: string;
	cwd: string;
	model?: string;
	tools: string[];
	stopReason?: string;
	error?: string;
	output: string;
	stderr?: string;
	durationMs: number;
	usage: UsageStats;
	events: RenderEvent[];
}

export interface SubagentRunningResult extends SubagentRunBase {
	status: "running";
}

export interface SubagentCompletedResult extends SubagentRunBase {
	status: "completed";
	exitCode: number;
	outputFile: string;
}

export type UnpersistedSubagentRunResult = Omit<SubagentCompletedResult, "outputFile">;
export type SubagentRunResult = SubagentRunningResult | SubagentCompletedResult;

export interface SubagentDetails {
	mode: SubagentMode;
	runId: string;
	tasks: NonEmptyArray<SubagentTask>;
	results: SubagentRunResult[];
	warnings: string[];
}

export interface SubagentToolResult extends AgentToolResult<SubagentDetails> {
	content: [{ type: "text"; text: string }];
}

export interface SubagentProgressEvent {
	phase: "starting" | "running" | "completed";
	result: SubagentToolResult;
}

export type SubagentProgressCallback = (event: SubagentProgressEvent) => void;

export interface SubagentInteractionPort {
	confirmWrite(title: string, message: string): Promise<boolean>;
}

export type ToolProgressStatus = "pending" | "running" | "completed" | "error";

export type RenderEvent =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown>; status?: ToolProgressStatus };

export interface ForkExecutionContext {
	snapshotPath: string;
	systemPromptPath: string;
	model: ParentModel;
	activeTools: readonly string[];
	thinkingLevel: string;
	sessionId: string;
	cwd: string;
}

interface ProcessRunBase {
	runId: string;
	mode: SubagentMode;
	agent: AgentDefinition;
	task: string;
	timeoutMs: number;
}

export type ProcessRunInput = ProcessRunBase & (
	| {
		contextMode: "isolated";
		cwd: string;
		model?: string;
		tools: string[];
	}
	| {
		contextMode: "fork";
		forkContext: ForkExecutionContext;
		assignment: string;
	}
);

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
	parseErrors: number;
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
}

interface ExecutorContextBase {
	cwd: string;
	currentModel: ParentModel | undefined;
	activeTools: readonly string[];
	allTools: readonly ToolInfo[];
	thinkingLevel: string;
	sessionManager: ParentSessionManager;
	systemPrompt: string;
	signal?: AbortSignal;
	interaction?: SubagentInteractionPort;
	onUpdate?: (partial: SubagentToolResult) => void;
}

export type ExecutorInvocation =
	| { invocation: "tool"; toolCallId: string }
	| { invocation: "command"; toolCallId?: never };

export type ExecutorContext = ExecutorContextBase & ExecutorInvocation;
