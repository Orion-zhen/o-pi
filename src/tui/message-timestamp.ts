import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const DEFAULT_PADDING_X = 1;

type UserTimestampTarget = "skill" | "user";

interface UserTimestamp {
	target: UserTimestampTarget;
	timestamp: number;
}

export interface MessageTimestampStyles {
	dim(text: string): string;
	userBackground(text: string): string;
	customBackground(text: string): string;
}

let styles: MessageTimestampStyles | undefined;
let installed = false;
let userTimestamps: UserTimestamp[] = [];
let nextUserTimestamp = 0;

const renderedTimestamps = new WeakMap<object, number>();
const assistantTimestamps = new WeakMap<AssistantMessageComponent, number>();

/** 安装内置消息组件补丁；重复调用只更新当前主题样式。 */
export function configureMessageTimestampRenderer(nextStyles: MessageTimestampStyles | undefined): void {
	styles = nextStyles;
	if (nextStyles === undefined || installed) return;
	installed = true;
	patchUserMessages();
	patchSkillMessages();
	patchAssistantMessages();
}

/** 用当前分支的可见用户消息重置渲染顺序。 */
export function resetUserMessageTimestamps(messages: readonly UserMessage[]): void {
	userTimestamps = messages.flatMap(toUserTimestamp);
	nextUserTimestamp = 0;
}

/** 实时用户消息先于 TUI 组件创建到达扩展事件，可在此登记真实时间。 */
export function recordUserMessageTimestamp(message: UserMessage): void {
	userTimestamps.push(...toUserTimestamp(message));
}

/** 按本地时区生成固定宽度时间戳。 */
export function formatMessageTimestamp(timestamp: number): string | undefined {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return undefined;
	return `[${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`;
}

function patchUserMessages(): void {
	const originalRender = UserMessageComponent.prototype.render;
	UserMessageComponent.prototype.render = function renderWithTimestamp(width: number): string[] {
		const lines = originalRender.call(this, width);
		const timestamp = timestampForUserComponent(this, "user");
		return timestamp === undefined
			? lines
			: insertTimestamp(lines, width, timestamp, readOutputPadding(this), styles?.userBackground, true);
	};
}

function patchSkillMessages(): void {
	const originalRender = SkillInvocationMessageComponent.prototype.render;
	SkillInvocationMessageComponent.prototype.render = function renderWithTimestamp(width: number): string[] {
		const lines = originalRender.call(this, width);
		const timestamp = timestampForUserComponent(this, "skill");
		return timestamp === undefined
			? lines
			: insertTimestamp(lines, width, timestamp, DEFAULT_PADDING_X, styles?.customBackground, true);
	};
}

function patchAssistantMessages(): void {
	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	AssistantMessageComponent.prototype.updateContent = function updateContentWithTimestamp(message: AssistantMessage): void {
		if (hasAssistantBody(message)) assistantTimestamps.set(this, message.timestamp);
		else assistantTimestamps.delete(this);
		originalUpdateContent.call(this, message);
	};

	const originalRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function renderWithTimestamp(width: number): string[] {
		const lines = originalRender.call(this, width);
		const timestamp = assistantTimestamps.get(this);
		return timestamp === undefined
			? lines
			: insertTimestamp(lines, width, timestamp, readOutputPadding(this), undefined, false);
	};
}

function hasAssistantBody(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "text" && content.text.trim().length > 0);
}

function timestampForUserComponent(component: object, target: UserTimestampTarget): number | undefined {
	const rendered = renderedTimestamps.get(component);
	if (rendered !== undefined) return rendered;
	if (styles === undefined || userTimestamps.length === 0) return undefined;

	if (nextUserTimestamp >= userTimestamps.length) nextUserTimestamp = 0;
	const next = userTimestamps[nextUserTimestamp];
	if (next?.target !== target) return undefined;
	nextUserTimestamp += 1;
	renderedTimestamps.set(component, next.timestamp);
	return next.timestamp;
}

function insertTimestamp(
	lines: string[],
	width: number,
	timestamp: number,
	paddingX: number,
	background: ((text: string) => string) | undefined,
	beforeBottomPadding: boolean,
): string[] {
	const currentStyles = styles;
	const label = formatMessageTimestamp(timestamp);
	if (currentStyles === undefined || label === undefined || lines.length === 0) return lines;

	const safeWidth = Math.max(1, Math.floor(width));
	const labelWidth = visibleWidth(label);
	const leftWidth = Math.max(0, safeWidth - paddingX - labelWidth);
	const rightWidth = Math.max(0, safeWidth - leftWidth - labelWidth);
	const line = `${" ".repeat(leftWidth)}${currentStyles.dim(label)}${" ".repeat(rightWidth)}`;
	const renderedLine = background?.(line) ?? line;
	const result = [...lines];
	result.splice(beforeBottomPadding ? Math.max(0, result.length - 1) : result.length, 0, renderedLine);
	return result;
}

function toUserTimestamp(message: UserMessage): UserTimestamp[] {
	const text = typeof message.content === "string"
		? message.content
		: message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("");
	if (text.length === 0) return [];
	const skillBlock = parseSkillBlock(text);
	return [{
		target: skillBlock !== null && skillBlock.userMessage === undefined ? "skill" : "user",
		timestamp: message.timestamp,
	}];
}

function readOutputPadding(component: object): number {
	const value: unknown = Reflect.get(component, "outputPad");
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_PADDING_X;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
