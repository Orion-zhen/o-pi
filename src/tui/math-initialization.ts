import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMathConfig } from "./types.js";

const IDLE_DELAY_MS = 750;

type MathMarkdownModule = typeof import("./math-markdown.js");

interface MathSession {
	ctx: ExtensionContext;
	config: TuiMathConfig;
	onReady(): void;
}

/** 加载结果跨会话复用，延迟任务只属于安排它的会话。 */
export class MathInitialization {
	private module: MathMarkdownModule | undefined;
	private warmed = false;
	private session: MathSession | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	configure(ctx: ExtensionContext, config: TuiMathConfig, onReady: () => void): void {
		this.reset();
		this.module?.installMathMarkdownRenderer(config);
		if (config.enabled) this.session = { ctx, config, onReady };
	}

	schedule(): void {
		this.cancel();
		const session = this.session;
		if (session === undefined || this.isReady()) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.isIdle(session) && !this.isReady()) void this.initialize(session);
		}, IDLE_DELAY_MS);
		this.timer.unref();
	}

	cancel(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	reset(): void {
		this.cancel();
		const previous = this.session;
		this.session = undefined;
		if (previous !== undefined) this.module?.installMathMarkdownRenderer({ ...previous.config, enabled: false });
	}

	private isReady(): boolean {
		return this.module !== undefined && (this.warmed || !this.module.supportsDisplayMathImages());
	}

	private isIdle(session: MathSession): boolean {
		return this.session === session && session.ctx.isIdle() && !session.ctx.hasPendingMessages();
	}

	private async initialize(session: MathSession): Promise<void> {
		try {
			const module = this.module ??= await import("./math-markdown.js");
			if (!this.isIdle(session)) return;
			module.installMathMarkdownRenderer(session.config);
			if (module.supportsDisplayMathImages()) {
				await module.warmDisplayMathRenderer();
				this.warmed = true;
			}
			if (this.isIdle(session)) session.onReady();
		} catch (error) {
			if (this.session === session) {
				const message = error instanceof Error ? error.message : String(error);
				session.ctx.ui.notify(`Math renderer initialization failed: ${message}`, "warning");
			}
		}
	}

}
