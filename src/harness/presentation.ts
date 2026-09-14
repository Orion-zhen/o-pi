import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";

/** SDK 定义的呈现插槽。业务模块只声明能力，不加载终端组件。 */
type Call = NonNullable<ToolDefinition<TSchema, unknown, object>["renderCall"]>;
export type ToolCallRenderer<Args = unknown> = (
	args: Args,
	theme: Parameters<Call>[1],
	context: Parameters<Call>[2],
) => ReturnType<Call>;
export type ToolResultRenderer = NonNullable<ToolDefinition<TSchema, unknown, object>["renderResult"]>;
