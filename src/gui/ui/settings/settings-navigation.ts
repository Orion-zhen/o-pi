import { Bot, Globe, HardDrive, MessageSquare, Palette, Plug, Shield, Terminal, Wrench } from "lucide-react";

export const settingsCategories = [
	{ id: "appearance", label: "外观", group: "使用偏好", icon: Palette },
	{ id: "conversation", label: "对话与输入", group: "使用偏好", icon: MessageSquare },
	{ id: "tools", label: "工具与代码", group: "代理能力", icon: Wrench },
	{ id: "web", label: "网络与网页", group: "代理能力", icon: Globe },
	{ id: "agents", label: "子代理", group: "代理能力", icon: Bot },
	{ id: "security", label: "权限与安全", group: "系统与扩展", icon: Shield },
	{ id: "connections", label: "连接与集成", group: "系统与扩展", icon: Plug },
	{ id: "storage", label: "存储管理", group: "系统与扩展", icon: HardDrive },
	{ id: "terminal", label: "终端界面", group: "系统与扩展", icon: Terminal },
] as const;

export type SettingsCategory = typeof settingsCategories[number]["id"];
