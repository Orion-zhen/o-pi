export class OAuthBrowser {
	private pending: Window | null = null;
	private active = false;
	private opened = new Set<string>();

	prepare(): void {
		this.finish();
		this.active = true;
		if (!window.opi) {
			this.pending = window.open("about:blank", "_blank");
			if (this.pending) {
				this.pending.opener = null;
				this.pending.document.title = "正在准备 OAuth 登录";
				this.pending.document.body.textContent = "正在准备认证页面，请在 opi 中完成登录方式选择。";
			}
		}
	}

	waitForInput(): void {
		this.pending?.close();
		this.pending = null;
	}

	resume(): void {
		if (this.active && this.opened.size === 0) this.prepare();
	}

	async open(url: string): Promise<void> {
		if (!this.active || this.opened.has(url)) return;
		if (!["https:", "http:"].includes(new URL(url).protocol)) throw new Error("无效认证链接。");
		this.opened.add(url);
		if (window.opi) await window.opi.openExternal(url);
		else if (this.pending && !this.pending.closed) {
			this.pending.location.replace(url);
			this.pending = null;
		}
	}

	finish(): void {
		this.pending?.close();
		this.pending = null;
		this.active = false;
		this.opened.clear();
	}
}
