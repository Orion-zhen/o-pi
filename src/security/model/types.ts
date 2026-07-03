export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ActionId =
	| "tool.invoke"
	| "tool.invoke.opaque"
	| "fs.list"
	| "fs.stat"
	| "fs.read"
	| "fs.create"
	| "fs.write"
	| "fs.replace"
	| "fs.delete"
	| "fs.rename"
	| "exec.shell.opaque"
	| "process.spawn"
	| "mcp.server.connect"
	| "mcp.tool.discover"
	| "mcp.tool.invoke"
	| "mcp.tool.invoke.opaque"
	| "mcp.resource.read"
	| "skill.discover"
	| "skill.activate"
	| "skill.instructions.read"
	| "skill.asset.read"
	| "skill.script.execute"
	| "agent.discover"
	| "agent.spawn"
	| "agent.delegate"
	| "agent.message.send"
	| "network.connect"
	| "secret.read"
	| "policy.read"
	| "policy.global.modify"
	| "policy.project.modify"
	| "grant.modify";

export type ResourceUri = string;
export type ComponentKind = "tool" | "bash" | "mcp-server" | "mcp-tool" | "skill" | "agent";
export type Exactness = "exact" | "conservative" | "opaque";
export type DecisionKind = "allow" | "ask" | "deny";

export interface AgentScope {
	/** Agent 创建时绑定的不可变工作根，不能由运行时 cwd 推导。 */
	root: string;
	/** 用户配置展开后的 canonical path glob；空数组表示仅 root 子树。 */
	patterns: readonly string[];
}

export interface DelegationCapability {
	issuerAgentInstanceId: string;
	subjectAgentInstanceId: string;
	actionPatterns: readonly string[];
	resourcePatterns: readonly string[];
	scopeRoot: string;
	expiresAt: number;
	maxCalls?: number;
	maxDepth: number;
	parentCapabilityDigest: string;
	nonce: string;
	signature: string;
}

export interface PrincipalContext {
	userId: string;
	sessionId: string;
	agentDefinitionId: string;
	agentInstanceId: string;
	parentAgentInstanceId?: string;
	lineage: readonly string[];
	scope: AgentScope;
	delegation: DelegationCapability;
}

export interface ComponentIdentity {
	id: string;
	kind: ComponentKind;
	displayName: string;
	sourceDigest: string;
	schemaDigest?: string;
	manifestDigest?: string;
}

export interface AuthorizationAtom {
	action: ActionId;
	resource: ResourceUri;
	attributes?: Readonly<Record<string, JsonValue>>;
}

export interface AuthorizationRequest {
	requestId: string;
	executionId: string;
	principal: PrincipalContext;
	component: ComponentIdentity;
	exactness: Exactness;
	inputDigest: string;
	atoms: readonly AuthorizationAtom[];
	context: {
		workspaceId: string;
		scopeUri: string;
		interactive: boolean;
		policyDigest: string;
		registryDigest: string;
		timestamp: number;
	};
}

export interface AnalysisContext {
	workspaceRoot: string;
	agentDir: string;
	component: ComponentIdentity;
	signal?: AbortSignal;
}

export interface AnalysisResult {
	exactness: Exactness;
	atoms: readonly AuthorizationAtom[];
}

export interface ComponentAnalyzer<Input = unknown> {
	analyze(input: Input, context: AnalysisContext): Promise<AnalysisResult>;
}

export interface ImmutableExecutionCall {
	executionId: string;
	principal: PrincipalContext;
	component: ComponentIdentity;
	input: unknown;
	context: {
		workspaceRoot: string;
		agentDir: string;
		interactive: boolean;
		signal?: AbortSignal;
	};
}

export interface ExecutionTicket {
	id: string;
	request: AuthorizationRequest;
	principalDigest: string;
	componentDigest: string;
	inputDigest: string;
	atomDigest: string;
	policyDigest: string;
	registryDigest: string;
	delegationDigest: string;
	expiry: number;
	nonce: string;
	consumed: boolean;
}

export interface AuthorizationDecision {
	kind: DecisionKind;
	reason: string;
	matchedPolicyIds: readonly string[];
	riskLabels: readonly string[];
}

export const allActions: readonly ActionId[] = [
	"tool.invoke",
	"tool.invoke.opaque",
	"fs.list",
	"fs.stat",
	"fs.read",
	"fs.create",
	"fs.write",
	"fs.replace",
	"fs.delete",
	"fs.rename",
	"exec.shell.opaque",
	"process.spawn",
	"mcp.server.connect",
	"mcp.tool.discover",
	"mcp.tool.invoke",
	"mcp.tool.invoke.opaque",
	"mcp.resource.read",
	"skill.discover",
	"skill.activate",
	"skill.instructions.read",
	"skill.asset.read",
	"skill.script.execute",
	"agent.discover",
	"agent.spawn",
	"agent.delegate",
	"agent.message.send",
	"network.connect",
	"secret.read",
	"policy.read",
	"policy.global.modify",
	"policy.project.modify",
	"grant.modify",
] as const;
