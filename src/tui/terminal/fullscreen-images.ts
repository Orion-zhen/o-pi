import type { TUI } from "@earendil-works/pi-tui";
import { KittyFrameAdapter } from "./kitty-frame.ts";

/** 编辑器工厂提供 Pi 的活动 TUI 引用。只适配该终端实例，不改上游原型。 */
export function installFullscreenImageFix(tui: TUI): () => void {
	const terminal = tui.terminal;
	const originalWrite = terminal.write;
	const adapter = new KittyFrameAdapter();
	const write = (data: string): void => {
		// Pi 切换模式时复用终端，活动 TUI 引用会指向新的 renderer。
		originalWrite.call(terminal, tui.mode === "fullscreen" ? adapter.rewrite(data) : data);
	};
	terminal.write = write;
	tui.requestRender(true);
	return () => {
		if (terminal.write === write) terminal.write = originalWrite;
	};
}
