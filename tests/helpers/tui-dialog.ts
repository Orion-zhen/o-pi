import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { plainTheme } from "../../src/gui/host/session/theme.ts";

// 只挂载组件，不启动终端或监听标准输入。
export function dialogUi(open: (dialog: Component) => void): Pick<ExtensionUIContext, "custom"> {
	const tui = new TuiMainScreen(new ProcessTerminal());
	return { custom: (factory) => new Promise((done, reject) => {
		Promise.resolve(factory(tui, plainTheme, new KeybindingsManager(), done)).then(open).catch(reject);
	}) };
}
