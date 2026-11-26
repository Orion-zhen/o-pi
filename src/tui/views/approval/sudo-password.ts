import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { renderBorderedPanel } from "../../components/scroll-viewer.ts";

export async function requestSudoPassword(ui: Pick<ExtensionUIContext, "custom">, retry: boolean, signal: AbortSignal): Promise<string | undefined> {
	if (signal.aborted) return;
	return ui.custom<string | undefined>(
		(_tui, theme, _keys, done) => new PasswordDialog(theme, retry, signal, done),
		{ overlay: true, overlayOptions: { width: 52 }, blocked: { kind: "auth", message: "sudo password required" } },
	);
}

// 不借用编辑器：密码不进入撤销栈、剪切环或渲染文本。
class PasswordDialog implements Component {
	private value = "";
	constructor(private readonly theme: Pick<Theme, "fg">, private readonly retry: boolean,
		private readonly signal: AbortSignal, private readonly done: (value?: string) => void) {
		signal.addEventListener("abort", this.dispose, { once: true });
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.dispose();
		else if (matchesKey(data, Key.enter)) {
			if (this.value) this.finish(this.value);
		} else if (matchesKey(data, Key.backspace)) {
			this.value = this.value.replace(/.$/su, "");
		} else if (matchesKey(data, Key.ctrl("u"))) this.value = "";
		else {
			// Pi 将一次括号粘贴作为完整事件投递，不把其中的回车当作提交键。
			const text = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~") ? data.slice(6, -6) : decodeKittyPrintable(data) ?? data;
			if (!/\p{Cc}/u.test(text)) this.value += text;
		}
	}

	render(width: number): string[] {
		const lines = [this.theme.fg("warning", "sudo password (input hidden)"),
			...(this.retry ? [this.theme.fg("error", "Authentication failed. Try again.")] : []),
			this.theme.fg("dim", "Enter submit | Esc / Ctrl+C cancel")];
		return width < 4 ? lines.map((line) => truncateToWidth(line, width, "")) : renderBorderedPanel(lines, width, this.theme);
	}
	invalidate(): void {}
	readonly dispose = () => this.finish();
	private finish(value?: string): void {
		this.signal.removeEventListener("abort", this.dispose);
		this.value = "";
		this.done(value);
	}
}
