export type McpObject = Record<string, unknown>;
export type McpConfig = McpObject & { mcpServers?: McpObject };
export type McpIssue = { field: string; message: string };
export const mcpExposures = ["codemode", "deferred", "direct", "hidden"] as const;

export function mcpObject(value: unknown): value is McpObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpConfig(content: string): McpConfig {
	if (!content.trim()) throw new Error("MCP 配置不能为空，请使用 {} 清空配置。");
	const value: unknown = JSON.parse(content);
	if (!mcpObject(value)) throw new Error("MCP 配置必须是 JSON 对象。");
	if (value.mcpServers !== undefined && !mcpObject(value.mcpServers)) throw new Error("mcpServers 必须是 JSON 对象。");
	return value;
}

function httpUrl(value: unknown): URL | undefined {
	if (typeof value !== "string" || !URL.canParse(value)) return undefined;
	const url = new URL(value);
	return ["http:", "https:"].includes(url.protocol) ? url : undefined;
}
const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const secure = (url: URL) => url.protocol === "https:" || loopback(url);
const exposure = (value: unknown) => value === "codemode-deferred" || mcpExposures.some((item) => item === value);

export function mcpDuplicateKeys(keys: readonly string[]): boolean {
	return new Set(keys).size !== keys.length;
}

/** 保存边界与表单共用校验，不解析凭据、不建立连接。 */
export function validateMcpServer(name: string, config: unknown): McpIssue[] {
	const issues: McpIssue[] = [];
	const error = (field: string, message: string) => { issues.push({ field, message }); };
	if (!/^[A-Za-z0-9_-]+$/.test(name)) error("name", "名称只能包含英文字母、数字、_ 和 -。");
	if (!mcpObject(config)) { error("", "服务配置必须是 JSON 对象，请通过 JSON 修复。"); return issues; }
	const string = (field: string) => {
		if (config[field] !== undefined && typeof config[field] !== "string") error(field, "必须是文本。");
	};
	string("description");
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") error("enabled", "启用状态必须是布尔值。");
	if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout <= 0)) error("timeout", "超时必须是大于 0 的秒数。");
	if (config.exposure !== undefined && !exposure(config.exposure)) error("exposure", "请选择有效的工具使用方式。");
	if (config.toolExposure !== undefined && (!mcpObject(config.toolExposure) || !Object.values(config.toolExposure).every(exposure))) error("toolExposure", "每条工具规则必须指定有效的使用方式。");
	for (const field of ["env", "headers", "toolExposure"]) {
		const value = config[field];
		if (!mcpObject(value)) continue;
		const keys = Object.keys(value);
		if (keys.includes("")) error(field, "名称不能为空。");
		if (field === "headers" && mcpDuplicateKeys(keys.map((key) => key.toLowerCase()))) error(field, "请求头名称不能重复，不区分大小写。");
	}
	const type = config.type;
	if (type === "sse") error("type", "不支持旧 SSE，请使用 Streamable HTTP 地址。");
	else if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") error("type", "连接类型必须是 stdio 或 HTTP。");
	const remote = typeof config.url === "string" && (type === undefined || type === "http" || type === "streamable-http");
	if (!remote && !(typeof config.command === "string" && (type === undefined || type === "stdio"))) error("type", "请填写启动程序或 HTTP 服务地址。");
	const map = (field: string) => {
		if (config[field] !== undefined && (!mcpObject(config[field]) || !Object.values(config[field]).every((value) => typeof value === "string"))) error(field, "名称和值必须是文本。");
	};
	if (!remote) {
		if (typeof config.command === "string" && !config.command.trim()) error("command", "请填写可执行程序，不要填写整条 shell 命令。");
		if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string"))) error("args", "启动参数必须是文本数组。");
		map("env"); string("cwd");
		return issues;
	}
	const url = httpUrl(config.url);
	if (!url) error("url", "请输入 http:// 或 https:// 服务地址。");
	map("headers");
	if (config.auth !== undefined) {
		if (!mcpObject(config.auth) || typeof config.auth.provider !== "string" || !config.auth.provider.trim()) error("auth.provider", "请填写提供商名称。");
		if (url && !secure(url)) error("url", "发送提供商凭据需要 HTTPS，本机回环地址除外。");
	}
	if (config.oauth !== undefined) validateOAuth(config.oauth, error);
	return issues;
}

function validateOAuth(value: unknown, error: (field: string, message: string) => void): void {
	if (!mcpObject(value)) { error("oauth", "OAuth 配置必须是 JSON 对象。"); return; }
	const issue = (field: string, message: string) => error(`oauth.${field}`, message);
	for (const field of ["clientId", "clientSecret", "scope", "clientName"]) {
		if (value[field] !== undefined && typeof value[field] !== "string") issue(field, "必须是文本。");
	}
	if (typeof value.clientName === "string" && !value.clientName.trim()) issue("clientName", "客户端名称不能为空。");
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) issue("callbackPort", "端口必须是 1–65535 的整数。");
	const callback = httpUrl(value.callbackUrl);
	if (value.callbackUrl !== undefined) {
		if (!callback || callback.protocol !== "http:" || !loopback(callback) || callback.search || callback.hash) issue("callbackUrl", "使用本机回环 HTTP 地址，不含查询参数或片段。");
		else if (callback.port && port !== undefined && Number(callback.port) !== port) issue("callbackPort", "端口与回调地址不一致。");
	}
	if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr" && value.clientRegistration !== "cimd") issue("clientRegistration", "请选择 DCR 或 CIMD。");
	if (value.clientRegistration === "cimd") {
		if (value.clientId !== undefined || value.clientName !== undefined) issue("clientRegistration", "CIMD 不能与客户端 ID 或客户端名称同时设置。");
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) issue("callbackUrl", "CIMD 回调需使用 localhost 或 127.0.0.1，路径为 /callback。");
	}
	if (value.authServerMetadataUrl !== undefined) {
		const url = httpUrl(value.authServerMetadataUrl);
		if (!url || !secure(url)) issue("authServerMetadataUrl", "元数据地址需要 HTTPS，本机回环地址除外。");
	}
}

export function mcpNameConflict(name: string, others: readonly string[]): string | undefined {
	return others.find((other) => other.replaceAll("-", "_") === name.replaceAll("-", "_"));
}

export function validateMcpConfig(value: McpConfig): string[] {
	const errors: string[] = [];
	if (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== "boolean") errors.push("autoEnableCodemode 必须是布尔值。");
	const names: string[] = [];
	if (value.mcpServers !== undefined) for (const [name, config] of Object.entries(value.mcpServers)) {
		const conflict = mcpNameConflict(name, names);
		if (conflict !== undefined) errors.push(`服务 ${name} 与 ${conflict} 名称冲突。`);
		names.push(name);
		for (const issue of validateMcpServer(name, config)) errors.push(`服务 ${name}${issue.field ? ` / ${issue.field}` : ""}：${issue.message}`);
	}
	return errors;
}
