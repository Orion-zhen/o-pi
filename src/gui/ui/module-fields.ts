import type { ModuleConfigId } from "../module-config.ts";

export interface ConfigField {
	path: string;
	label: string;
	options?: readonly string[];
}
const field = (path: string, label: string, options?: readonly string[]): ConfigField => ({ path, label, ...(options ? { options } : {}) });

export const moduleFields: Record<ModuleConfigId, ConfigField[]> = {
	autoTitle: [field("enabled", "自动生成标题"), field("model", "标题模型（留空使用当前模型）")],
	bashTool: [
		field("default_timeout_seconds", "默认超时（秒）"), field("python_venv_paths", "Python 虚拟环境目录"),
		field("environment.inherit", "继承进程环境变量"), field("environment.expose_pi_session_file", "暴露会话文件路径"),
	],
	fileTools: [
		field("ignored_path", "软忽略路径"), field("blocked_path", "禁止访问路径"),
		field("ignore.piignore", "遵循 .piignore"), field("ignore.gitignore", "遵循 .gitignore"),
		field("ignore.git_tracked_files_bypass", "已跟踪文件绕过忽略规则"),
	],
	webTools: [
		field("network.proxy.enabled", "启用代理"), field("network.proxy.http_proxy", "HTTP 代理"),
		field("network.proxy.https_proxy", "HTTPS 代理"), field("network.proxy.socks5_proxy", "SOCKS5 代理"),
		field("websearch.default_results", "默认搜索结果数"), field("websearch.include_domains", "包含域名"),
		field("websearch.exclude_domains", "排除域名"),
		field("websearch.brave_api.enabled", "启用 Brave"), field("websearch.exa_api.enabled", "启用 Exa"),
		field("websearch.tavily.enabled", "启用 Tavily"), field("websearch.duckduckgo_html.enabled", "启用 DuckDuckGo"),
		field("webfetch.media.mode", "网页图片", ["off", "auto"]),
		field("webfetch.cookies.enabled", "使用浏览器 Cookie"), field("webfetch.cookies.domains", "Cookie 域名"),
		field("webfetch.cookies.confirmation", "Cookie 发送确认", ["always", "session", "never"]),
	],
	approvalGate: [
		field("enabled", "启用权限审批"), field("remember.allow_session", "允许会话内记住授权"),
		field("remember.allow_persistent", "允许永久记住授权"), field("ui.timeout_ms", "审批超时（毫秒，0 不超时）"),
		field("ui.non_interactive", "非交互审批策略", ["block", "allow"]),
		...["write", "edit", "webfetch", "bash"].map((tool) => field(`tools.${tool}.default_action`, `${tool} 默认动作`, ["allow", "ask", "deny"])),
	],
	subagent: [
		field("default_model", "默认模型（留空继承）"), field("max_parallel_tasks", "最大并行任务数"),
		field("max_concurrency", "单个任务并发数"), field("timeout_ms", "超时（毫秒）"), field("retries", "重试次数"),
		field("retry_on_empty_output", "空输出时重试"), field("retry_on_timeout", "超时时重试"),
		field("default_tools", "默认工具"), field("allow_project_agents", "允许项目子代理"),
		field("project_agents_override_user", "项目子代理覆盖用户定义"), field("confirm_write_agents", "写入子代理前确认"),
	],
	lsp: [
		field("enabled", "启用 LSP"), field("diagnostics.enabled", "启用诊断"),
		field("diagnostics.min_severity", "最低诊断级别", ["error", "warning", "information", "hint"]),
		field("read.outline", "读取时显示大纲"), field("grep.workspace_symbols", "搜索工作区符号"),
		field("exclude_paths", "排除路径"), field("request_timeout_ms", "请求超时（毫秒）"),
	],
	discordPresence: [
		field("enabled", "启用 Discord 状态"), field("profile", "展示档案", ["minimal", "standard", "detailed"]),
		field("application_id", "应用 ID"), field("update_interval_ms", "更新间隔（毫秒）"), field("retry_interval_ms", "重连间隔（毫秒）"),
	],
	tui: [
		field("enabled", "启用终端界面增强"), field("icons", "图标", ["nerd", "unicode", "ascii"]),
		field("chrome.title", "终端标题"), field("chrome.header", "显示标题栏"), field("chrome.footer", "显示页脚"),
		field("home.enabled", "显示首页"), field("home.show_tips", "显示提示"), field("math.enabled", "数学公式渲染"),
	],
	tools: [],
};
