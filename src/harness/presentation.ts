import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 呈现器由宿主注入。GUI 使用标准交互能力，终端呈现器只在 TUI 加载。 */
export interface Presenter<T> {
	mode: "tui" | "gui";
	show: T;
}
export function canPresent(ctx: Pick<ExtensionContext, "mode" | "hasUI">, presenter: Presenter<unknown> | undefined): boolean {
	return presenter !== undefined && (presenter.mode === "tui" ? ctx.mode === "tui" : ctx.hasUI);
}
