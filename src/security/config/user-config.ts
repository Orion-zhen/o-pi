export const userPermissionModes = ["off", "allow", "ask", "always-ask"] as const;

/** 用户唯一可配置模式；越靠后限制越强，下层只能收紧。 */
export type UserPermissionMode = (typeof userPermissionModes)[number];

export type UserModeMap = Record<string, UserPermissionMode>;

/** MCP 在用户配置中固定为 server -> tool 两级名称；"*" 是唯一通配符。 */
export type UserMcpModeMap = Record<string, UserModeMap | UserPermissionMode>;

/** 用户可见组件配置，只接受 catalog 名称和四种模式。 */
export interface UserPermissionSection {
	tools?: UserModeMap;
	mcp?: UserMcpModeMap;
	skills?: UserModeMap;
	subagents?: UserModeMap;
}

export interface UserPathPermissionRule {
	match?: string;
	outsideWorkspace?: true;
	agents: Record<string, UserPermissionSection>;
}

export interface UserApprovalConfig {
	ask?: { remember?: readonly ("once" | "session" | "persistent")[] };
	"always-ask"?: { remember?: readonly ["once"] };
}

/** 普通用户手写的权限配置；禁止出现内部 action、resource、principal 或 digest。 */
export interface UserPermissionConfig {
	$schema?: string;
	version: 1;
	global?: UserPermissionSection;
	agents?: Record<string, UserPermissionSection>;
	paths?: readonly UserPathPermissionRule[];
	approval?: UserApprovalConfig;
	audit?: { enabled: boolean };
}

/** 用于比较和合并模式的固定强度：allow < ask < always-ask < off。 */
export function modeRank(mode: UserPermissionMode): number {
	if (mode === "allow") return 0;
	if (mode === "ask") return 1;
	if (mode === "always-ask") return 2;
	return 3;
}

export function strictestMode(...modes: readonly (UserPermissionMode | undefined)[]): UserPermissionMode | undefined {
	let result: UserPermissionMode | undefined;
	for (const mode of modes) {
		if (mode === undefined) continue;
		if (result === undefined || modeRank(mode) > modeRank(result)) result = mode;
	}
	return result;
}

export function isUserPermissionMode(value: unknown): value is UserPermissionMode {
	return typeof value === "string" && userPermissionModes.includes(value as UserPermissionMode);
}

export function defaultUserPermissionConfig(): UserPermissionConfig {
	return {
		$schema: "./permissions.schema.json",
		version: 1,
		global: {
			tools: { ls: "allow", read: "allow", edit: "allow", bash: "off", "*": "off" },
			mcp: { "*": "off" },
			skills: { "*": "off" },
			subagents: { main: "off", "*": "off" },
		},
		agents: {
			main: {
				tools: { ls: "allow", read: "allow", edit: "allow", bash: "off", "*": "off" },
				mcp: { "*": "off" },
				skills: { "*": "off" },
				subagents: { "*": "off" },
			},
		},
		paths: [
			{
				match: "${workspace}/**",
				agents: {
					main: {
						tools: { ls: "allow", read: "allow", edit: "allow", bash: "off" },
						mcp: { "*": "off" },
						skills: { "*": "off" },
						subagents: { "*": "off" },
					},
				},
			},
			{
				outsideWorkspace: true,
				agents: {
					"*": {
						tools: { ls: "ask", read: "ask", edit: "always-ask", bash: "off" },
						mcp: { "*": "off" },
						skills: { "*": "off" },
						subagents: { "*": "off" },
					},
				},
			},
		],
		approval: {
			ask: { remember: ["once", "session", "persistent"] },
			"always-ask": { remember: ["once"] },
		},
		audit: { enabled: true },
	};
}
