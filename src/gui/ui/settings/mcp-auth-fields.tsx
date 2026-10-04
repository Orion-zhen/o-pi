import { mcpObject, type McpIssue, type McpObject } from "../../mcp-validation.ts";
import { SettingsDisclosure } from "./settings-controls.tsx";
import { McpChoice, McpField, McpPairs, McpTextField, mcpText } from "./mcp-fields.tsx";
import { mcpId, type McpAuthMode, type McpPair, type McpServerDraft } from "./mcp-draft.ts";

export function McpAuthFields({ server, config, issues, change, disabled }: {
	server: McpServerDraft; config: McpObject; issues: McpIssue[]; change: (server: McpServerDraft) => void; disabled: boolean;
}) {
	const headers = server.maps.headers ?? [];
	const authorization = headers.find((row) => row.key.toLowerCase() === "authorization");
	const mode = server.authMode;
	const hiddenAuthorization = mode === "bearer" ? authorization : undefined;
	const extraHeaderCount = headers.length - (hiddenAuthorization ? 1 : 0);
	const setHeaders = (rows: McpPair[]) => change({ ...server, maps: { ...server.maps, headers: rows } });
	const setMode = (value: McpAuthMode) => {
		const next = { ...config };
		delete next.auth;
		const rows = headers.filter((row) => row.key.toLowerCase() !== "authorization");
		if (value === "bearer" || value === "headers") rows.push({ id: mcpId(), key: "Authorization", value: value === "bearer" ? "Bearer " : "" });
		if (value === "provider") next.auth = { provider: "" };
		change({ ...server, authMode: value, config: next, maps: { ...server.maps, headers: rows } });
	};
	const oauth = mcpObject(config.oauth) ? config.oauth : {};
	const setOAuth = (field: string, value: unknown) => {
		const next = { ...oauth };
		if (value === "") delete next[field]; else next[field] = value;
		const updated = { ...config };
		if (Object.keys(next).length) updated.oauth = next; else delete updated.oauth;
		change({ ...server, config: updated });
	};
	return <>
		<McpField label="认证方式" hint="自动模式在服务要求时使用 OAuth。切换认证方式会移除原认证头或提供商设置。">
			<McpChoice disabled={disabled} label="认证方式" value={mode} options={[["auto", "自动 / 按需 OAuth"], ["bearer", "Bearer Token"], ["headers", "自定义认证头"], ["provider", "已登录的提供商"]]} change={setMode} />
		</McpField>
		{mode === "bearer" && <McpTextField label="Bearer Token" field="headers" value={mcpText(authorization?.value).slice(7)} secret
			hint="可填写令牌或 ${TOKEN_ENV}。环境变量来自运行 opi 的进程。"
			onChange={(value) => setHeaders(headers.map((row) => row === authorization ? { ...row, value: `Bearer ${value}` } : row))} />}
		{mode === "provider" && <McpTextField label="提供商名称" field="auth.provider" issues={issues} value={mcpObject(config.auth) ? config.auth.provider : ""}
			hint="将该提供商的登录凭据发送至此服务地址，仅用于可信服务。"
			onChange={(provider) => change({ ...server, config: { ...config, auth: { ...(mcpObject(config.auth) ? config.auth : {}), provider } } })} />}
		{mode === "headers" ? <McpField label="请求头" field="headers" issues={issues}>
			<McpPairs disabled={disabled} label="请求头" rows={headers} change={setHeaders} />
		</McpField> : <SettingsDisclosure title={`自定义请求头${extraHeaderCount ? `（${extraHeaderCount}）` : ""}`}>
			<McpField label="请求头" field="headers" issues={issues} hint="支持 ${ENV_NAME} 和整个值为 !command 的命令取值。不要重复设置提供商凭据和 Authorization。">
				<McpPairs disabled={disabled} label="请求头" rows={headers} hiddenId={hiddenAuthorization?.id} change={setHeaders} />
			</McpField>
		</SettingsDisclosure>}
		<SettingsDisclosure title="OAuth 高级设置">
			<p className="settings-description">通常无需填写。提供 Authorization 或提供商凭据时，不使用 OAuth。</p>
			<div className="mcp-form-grid">
				<McpField label="客户端注册" field="oauth.clientRegistration" issues={issues}>
					<McpChoice disabled={disabled} label="客户端注册" value={mcpText(oauth.clientRegistration ?? "dcr")} options={[["dcr", "动态注册（默认）"], ["cimd", "Pi 客户端元数据（CIMD）"]]} change={(value) => setOAuth("clientRegistration", value === "dcr" ? "" : value)} />
				</McpField>
				{([
					["clientId", "客户端 ID"], ["clientSecret", "客户端密钥"], ["clientName", "客户端名称"], ["scope", "权限范围"],
					["callbackUrl", "回调地址"], ["callbackPort", "回调端口"], ["authServerMetadataUrl", "授权服务器元数据地址"],
				] as const).map(([field, label]) => <McpTextField key={field} label={label} field={`oauth.${field}`} issues={issues} value={oauth[field]}
					secret={field === "clientSecret"} numeric={field === "callbackPort"} onChange={(value) => setOAuth(field, field === "callbackPort" && value.trim() ? Number(value) || value : value)} />)}
			</div>
			<p className="settings-description">权限范围用空格分隔。客户端密钥支持环境变量和命令取值。元数据地址会被直接信任，仅填写可信地址。</p>
		</SettingsDisclosure>
	</>;
}
