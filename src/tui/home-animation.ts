import type { TUI } from "@earendil-works/pi-tui";
import { HomePointerController, type HomePointerFrame } from "./home-pointer.js";
import type { TuiHomeConfig } from "./types.js";

const INTRO_FRAME_MS = 80;
const SUBTLE_INTRO_MS = 640;
const PLAYFUL_INTRO_MS = 960;
const ORBIT_FRAME_MS = 650;

export interface HomeAnimationFrame {
	reveal: number;
	wave: number;
	orbit: number;
	pointer?: HomePointerFrame;
}

/** 只由可见的 fullscreen Home 创建，退出时统一释放动效资源。 */
export class HomeAnimation {
	private readonly startedAt = performance.now();
	private readonly duration: number;
	private readonly pointer: HomePointerController;
	private introTimer: ReturnType<typeof setInterval> | undefined;
	private orbitTimer: ReturnType<typeof setInterval> | undefined;

	constructor(tui: TUI, config: TuiHomeConfig, isVisible: () => boolean) {
		this.duration = config.motion === "off" ? 0 : config.motion === "playful" ? PLAYFUL_INTRO_MS : SUBTLE_INTRO_MS;
		this.pointer = new HomePointerController({
			effects: config.pointer_effects,
			isActive: isVisible,
			requestRender: () => tui.requestRender(),
		});
		if (this.duration > 0) {
			this.introTimer = setInterval(() => {
				if (!isVisible()) this.dispose();
				else if (performance.now() - this.startedAt >= this.duration) {
					clearInterval(this.introTimer);
					this.introTimer = undefined;
				}
				tui.requestRender();
			}, INTRO_FRAME_MS);
			this.introTimer.unref();
		}
		if (config.motion === "playful") {
			this.orbitTimer = setInterval(() => {
				if (!isVisible()) this.dispose();
				else tui.requestRender();
			}, ORBIT_FRAME_MS);
			this.orbitTimer.unref();
		}
	}

	getFrame(): HomeAnimationFrame {
		const elapsed = Math.max(0, performance.now() - this.startedAt);
		const pointer = this.pointer.getFrame();
		return {
			reveal: this.duration === 0 ? 1 : Math.min(1, elapsed / (this.duration * 0.55)),
			wave: this.duration === 0 ? 1 : Math.min(1, Math.max(0, (elapsed - this.duration * 0.25) / (this.duration * 0.75))),
			orbit: this.orbitTimer === undefined ? 0 : Math.floor(elapsed / ORBIT_FRAME_MS) % 4,
			...(pointer === undefined ? {} : { pointer }),
		};
	}

	dispose(): void {
		clearInterval(this.introTimer);
		clearInterval(this.orbitTimer);
		this.introTimer = undefined;
		this.orbitTimer = undefined;
		this.pointer.dispose();
	}
}
