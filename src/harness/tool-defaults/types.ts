export const TOOL_PRESETS = ["vanilla", "web-chat", "offline", "no-tools"] as const;
export type ToolPreset = typeof TOOL_PRESETS[number];
