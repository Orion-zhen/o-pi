import { type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";

/** SDK 定义的呈现插槽。业务模块只声明能力，不加载终端组件。 */
type Call = NonNullable<ToolDefinition<TSchema, unknown, object>["renderCall"]>;
export type ToolCallRenderer<Args = unknown> = (
	args: Args,
	theme: Parameters<Call>[1],
	context: Parameters<Call>[2],
) => ReturnType<Call>;
export type ToolResultRenderer = NonNullable<ToolDefinition<TSchema, unknown, object>["renderResult"]>;

/** 呈现器由宿主注入。GUI 使用标准交互能力，终端呈现器只在 TUI 加载。 */
export interface Presenter<T> {
	mode: "tui" | "gui";
	show: T;
}
export function canPresent(ctx: Pick<ExtensionContext, "mode" | "hasUI">, presenter: Presenter<unknown> | undefined): boolean {
	return presenter !== undefined && (presenter.mode === "tui" ? ctx.mode === "tui" : ctx.hasUI);
}
