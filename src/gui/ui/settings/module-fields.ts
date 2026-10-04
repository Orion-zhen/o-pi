import type { ModuleConfigId } from "../../module-config.ts";

export interface ConfigField {
	path: string;
	label: string;
	type?: "model" | "tools" | "profile";
	enabledBy?: string;
}
interface ConfigGroup {
	title: string;
	fields: ConfigField[];
	advanced?: boolean;
}
const field = (path: string, label: string, type?: ConfigField["type"]): ConfigField =>
	({ path, label, ...(type ? { type } : {}) });

export const optionLabels: Record<string, string> = {
	off: "关闭", auto: "自动", on: "开启", always: "每次确认", session: "每个会话确认", never: "不确认",
	block: "阻止", allow: "允许", ask: "询问", deny: "拒绝",
	error: "错误", warning: "警告", information: "信息", hint: "提示",
	minimal: "最少信息", standard: "标准", detailed: "详细信息",
	nerd: "Nerd Font", unicode: "Unicode", ascii: "ASCII",
};

export const moduleGroups: Record<ModuleConfigId, ConfigGroup[]> = {
	autoTitle: [{ title: "自动标题", fields: [
		field("enabled", "自动生成标题"), { ...field("model", "标题模型", "model"), enabledBy: "enabled" },
	] }],
	bashTool: [
		{ title: "终端执行", fields: [field("default_timeout_seconds", "超时（秒）"), field("python_venv_paths", "Python 虚拟环境")] },
		{ title: "执行环境", advanced: true, fields: [field("environment.inherit", "继承环境变量"), field("environment.expose_pi_session_file", "暴露会话文件路径")] },
	],
	fileTools: [{ title: "文件访问", fields: [
		field("ignored_path", "忽略路径"), field("blocked_path", "禁止访问路径"),
		field("ignore.piignore", "遵循 .piignore"), field("ignore.gitignore", "遵循 .gitignore"),
		field("ignore.git_tracked_files_bypass", "已跟踪文件绕过忽略"),
	] }],
	webTools: [
		{ title: "网络代理", fields: [
			field("network.proxy.enabled", "代理"),
			...[field("network.proxy.http_proxy", "HTTP 代理"), field("network.proxy.https_proxy", "HTTPS 代理"), field("network.proxy.socks5_proxy", "SOCKS5 代理")]
				.map((item) => ({ ...item, enabledBy: "network.proxy.enabled" })),
		] },
		{ title: "网页搜索", fields: [
			field("websearch.default_results", "结果数量"), field("websearch.include_domains", "包含域名"), field("websearch.exclude_domains", "排除域名"),
			field("websearch.brave_api.enabled", "Brave"), field("websearch.exa_api.enabled", "Exa"),
			field("websearch.tavily.enabled", "Tavily"), field("websearch.duckduckgo_html.enabled", "DuckDuckGo"),
		] },
		{ title: "网页读取", fields: [
			field("webfetch.media.mode", "网页图片"), field("webfetch.cookies.enabled", "浏览器 Cookie"),
			{ ...field("webfetch.cookies.domains", "Cookie 域名"), enabledBy: "webfetch.cookies.enabled" },
			{ ...field("webfetch.cookies.confirmation", "发送 Cookie"), enabledBy: "webfetch.cookies.enabled" },
		] },
	],
	approvalGate: [
		{ title: "权限审批", fields: [field("enabled", "权限审批"), field("ui.timeout_ms", "审批超时（毫秒，0 不超时）"), field("ui.non_interactive", "非交互操作")] },
		{ title: "工具默认权限", fields: [
			field("tools.write.default_action", "写入文件"), field("tools.edit.default_action", "编辑文件"),
			field("tools.webfetch.default_action", "读取网页"), field("tools.bash.default_action", "执行命令"),
		] },
		{ title: "授权记忆", fields: [field("remember.allow_session", "允许会话授权"), field("remember.allow_persistent", "允许永久授权")] },
	],
	subagent: [
		{ title: "默认配置", fields: [field("default_model", "默认模型", "model"), field("default_tools", "默认工具", "tools")] },
		{ title: "任务执行", fields: [
			field("max_parallel_tasks", "最大并行任务数"), field("max_concurrency", "单任务并发数"), field("timeout_ms", "超时（毫秒）"),
			field("retries", "重试次数"), field("retry_on_empty_output", "空输出时重试"), field("retry_on_timeout", "超时时重试"),
		] },
		{ title: "项目子代理", fields: [field("allow_project_agents", "允许项目子代理"), field("project_agents_override_user", "项目定义优先"), field("confirm_write_agents", "写入前确认")] },
	],
	lsp: [
		{ title: "代码智能", fields: [
			field("enabled", "LSP"), field("diagnostics.enabled", "代码诊断"),
			field("diagnostics.min_severity", "诊断级别"),
			field("read.outline", "读取时显示大纲"), field("grep.workspace_symbols", "搜索工作区符号"),
		] },
		{ title: "代码智能高级选项", advanced: true, fields: [field("exclude_paths", "排除路径"), field("request_timeout_ms", "请求超时（毫秒）")] },
	],
	discordPresence: [
		{ title: "Discord 状态", fields: [field("enabled", "显示 Discord 状态"), { ...field("profile", "展示内容", "profile"), enabledBy: "enabled" }] },
		{ title: "Discord 高级选项", advanced: true, fields: [field("application_id", "应用 ID"), field("update_interval_ms", "更新间隔（毫秒）"), field("retry_interval_ms", "重连间隔（毫秒）")] },
	],
	tui: [
		{ title: "CLI 外观", fields: [
			field("enabled", "界面增强"), field("icons", "图标"),
			field("chrome.title", "终端标题"), field("chrome.header", "显示标题栏"), field("chrome.footer", "显示页脚"),
		] },
		{ title: "首页与渲染", fields: [field("home.enabled", "显示首页"), field("home.show_tips", "显示提示"), field("math.enabled", "数学公式")] },
	],
};
