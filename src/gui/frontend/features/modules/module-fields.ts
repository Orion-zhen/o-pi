import type { ModuleConfigId } from "../../../shared/config/modules.ts";

export interface ConfigField {
	path: string;
	type?: "model" | "thinking" | "tools" | "profile" | "searchProviders" | "radio";
	enabledBy?: string;
	optionLabels?: Record<string, string>;
}
interface ConfigGroup {
	title: string;
	fields: ConfigField[];
	advanced?: boolean;
}
const field = (path: string, type?: ConfigField["type"]): ConfigField =>
	({ path, ...(type ? { type } : {}) });

export const moduleGroups: Record<ModuleConfigId, ConfigGroup[]> = {
	autoTitle: [{ title: "自动标题", fields: [
		field("enabled"), field("model", "model"),
		field("thinking_level", "thinking"), field("max_messages"),
	] }],
	shellTools: [
		{ title: "终端执行", fields: [field("default_timeout_seconds"), field("python_venv_paths")] },
		{ title: "执行环境", advanced: true, fields: [field("environment.inherit"), field("environment.expose_pi_session_file")] },
	],
	fileTools: [{ title: "文件访问", fields: [
		field("ignored_path"), field("blocked_path"),
		field("ignore.piignore"), field("ignore.gitignore"),
		field("ignore.git_tracked_files_bypass"),
		field("limits.read_outline_symbols"),
	] }],
	webTools: [
		{ title: "网络代理", fields: [
			field("network.proxy.enabled"),
			...[field("network.proxy.http_proxy"), field("network.proxy.https_proxy"), field("network.proxy.socks5_proxy")]
				.map((item) => ({ ...item, enabledBy: "network.proxy.enabled" })),
		] },
		{ title: "网页搜索", fields: [
			field("websearch.default_results"), field("websearch.include_domains"), field("websearch.exclude_domains"),
		] },
		{ title: "搜索引擎", fields: [field("websearch.primary_providers", "searchProviders")] },
		{ title: "网页读取", fields: [
			{ ...field("webfetch.media.mode", "radio"), optionLabels: { auto: "自动", on: "开启", off: "关闭" } },
			field("webfetch.cookies.enabled"),
			{ ...field("webfetch.cookies.blacklist"), enabledBy: "webfetch.cookies.enabled" },
		] },
	],
	approvalGate: [
		{ title: "权限审批", fields: [field("enabled"), field("ui.timeout_ms"), field("ui.non_interactive", "radio")] },
		{ title: "AI 辅助审批", fields: [
			field("ai_review.enabled"), field("ai_review.model", "model"), field("ai_review.thinking_level", "thinking"),
			field("ai_review.auto_apply_seconds"),
			field("ai_review.max_turns"), field("ai_review.max_tool_calls"),
		] },
		{ title: "工具默认权限", fields: [
			field("tools.shell.default_action", "radio"), field("tools.write.default_action", "radio"), field("tools.edit.default_action", "radio"),
			field("tools.webfetch.default_action", "radio"),
		] },
	],
	subagent: [
		{ title: "默认配置", fields: [field("default_model", "model"), field("default_tools", "tools")] },
		{ title: "任务执行", fields: [
			field("max_parallel_tasks"), field("max_concurrency"), field("timeout_ms"),
			field("retries"), field("retry_on_empty_output"), field("retry_on_timeout"),
		] },
		{ title: "项目子代理", fields: [field("allow_project_agents"), field("project_agents_override_user"), field("confirm_write_agents")] },
	],
	lsp: [
		{ title: "代码智能", fields: [
			field("enabled"), field("diagnostics.enabled"),
			field("diagnostics.min_severity", "radio"),
			field("grep.workspace_symbols"),
		] },
		{ title: "代码智能高级选项", advanced: true, fields: [field("exclude_paths"), field("request_timeout_ms")] },
	],
	discordPresence: [
		{ title: "Discord 状态", fields: [field("enabled"), { ...field("profile", "profile"), enabledBy: "enabled" }] },
		{ title: "Discord 高级选项", advanced: true, fields: [field("application_id"), field("update_interval_ms"), field("retry_interval_ms")] },
	],
	tui: [
		{ title: "CLI 外观", fields: [
			field("enabled"), field("icons", "radio"),
			field("chrome.title"), field("chrome.header"), field("chrome.footer"),
		] },
		{ title: "首页与渲染", fields: [field("home.enabled"), field("home.show_tips"), field("math.enabled")] },
	],
};
