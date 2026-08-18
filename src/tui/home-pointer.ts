import { StdinBuffer } from "@earendil-works/pi-tui";
import type { TuiHomePointerEffects } from "./types.js";

const FRAME_MS = 70;
const LONG_PRESS_MS = 450;
const MAX_PRESS_MS = 6_000;
const DOUBLE_CLICK_MS = 360;
const CLICK_DISTANCE = 2;
const RIPPLE_MS = 560;
const BURST_MS = 720;
const EXPLODE_MS = 820;

export interface HomePointerInput {
	readonly isTTY?: boolean;
	on(event: "data", listener: (data: string | Buffer) => void): unknown;
	off(event: "data", listener: (data: string | Buffer) => void): unknown;
}

export interface HomeMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

export interface HomePointerFrame {
	kind: "press" | "charge" | "ripple" | "burst" | "explode";
	progress: number;
	x: number;
	y: number;
}

export interface HomePointerControllerOptions {
	effects: TuiHomePointerEffects;
	isActive(): boolean;
	requestRender(): void;
	input?: HomePointerInput;
}

interface PressState {
	x: number;
	y: number;
	startedAt: number;
	dragged: boolean;
}

interface TimedEffect {
	kind: "ripple" | "burst" | "explode";
	x: number;
	y: number;
	startedAt: number;
	duration: number;
}

interface PreviousClick {
	x: number;
	y: number;
	at: number;
}

/**
 * 被动观察 fullscreen 已启用的 SGR Mouse，不消费或改写 Pi 的输入链。
 * 不支持鼠标的终端会静默退化；拖动留给 Pi 原生文本选择。
 */
export class HomePointerController {
	private readonly options: HomePointerControllerOptions;
	private readonly input: HomePointerInput;
	private readonly buffer: StdinBuffer | undefined;
	private press: PressState | undefined;
	private effect: TimedEffect | undefined;
	private previousClick: PreviousClick | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(options: HomePointerControllerOptions) {
		this.options = options;
		this.input = options.input ?? process.stdin;
		if (options.effects === "off" || this.input.isTTY !== true) {
			this.buffer = undefined;
			return;
		}
		const buffer = new StdinBuffer();
		this.buffer = buffer;
		buffer.on("data", this.handleBufferedInput);
		this.input.on("data", this.handleRawInput);
	}

	getFrame(now = Date.now()): HomePointerFrame | undefined {
		if (this.disposed || !this.options.isActive()) return undefined;
		const press = this.press;
		if (press !== undefined && !press.dragged) {
			const elapsed = Math.max(0, now - press.startedAt);
			if (this.options.effects === "click-hold" && elapsed >= LONG_PRESS_MS) {
				return {
					kind: "charge",
					progress: ((elapsed - LONG_PRESS_MS) % 900) / 900,
					x: press.x,
					y: press.y,
				};
			}
			return {
				kind: "press",
				progress: Math.min(1, elapsed / LONG_PRESS_MS),
				x: press.x,
				y: press.y,
			};
		}
		const effect = this.effect;
		if (effect === undefined) return undefined;
		const elapsed = Math.max(0, now - effect.startedAt);
		if (elapsed >= effect.duration) return undefined;
		return {
			kind: effect.kind,
			progress: elapsed / effect.duration,
			x: effect.x,
			y: effect.y,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopTimer();
		this.press = undefined;
		this.effect = undefined;
		this.previousClick = undefined;
		this.input.off("data", this.handleRawInput);
		if (this.buffer !== undefined) {
			this.buffer.off("data", this.handleBufferedInput);
			this.buffer.destroy();
		}
	}

	private readonly handleRawInput = (data: string | Buffer): void => {
		if (this.disposed || !this.options.isActive()) return;
		this.buffer?.process(data);
	};

	private readonly handleBufferedInput = (data: string): void => {
		const event = parseSgrMouseEvent(data);
		if (event === undefined || !this.options.isActive()) return;
		this.handleMouseEvent(event);
	};

	private handleMouseEvent(event: HomeMouseEvent): void {
		if ((event.button & 64) !== 0) return;
		const button = event.button & 3;
		const motion = (event.button & 32) !== 0;
		if (motion) {
			const press = this.press;
			if (press === undefined || button !== 0) return;
			if (distance(press, event) > CLICK_DISTANCE) {
				press.dragged = true;
				this.effect = undefined;
				this.options.requestRender();
			}
			return;
		}
		if (event.release) {
			if (button !== 0 && button !== 3) return;
			this.finishPress(event);
			return;
		}
		if (button !== 0) return;
		this.press = { x: event.x, y: event.y, startedAt: Date.now(), dragged: false };
		this.effect = undefined;
		this.ensureTimer();
		this.options.requestRender();
	}

	private finishPress(event: HomeMouseEvent): void {
		const press = this.press;
		if (press === undefined) return;
		this.press = undefined;
		const now = Date.now();
		if (press.dragged || distance(press, event) > CLICK_DISTANCE) {
			this.previousClick = undefined;
			this.effect = undefined;
			this.stopTimer();
			this.options.requestRender();
			return;
		}
		const heldFor = now - press.startedAt;
		if (this.options.effects === "click-hold" && heldFor >= LONG_PRESS_MS) {
			this.previousClick = undefined;
			this.startEffect("explode", event.x, event.y, now, EXPLODE_MS);
			return;
		}
		const previous = this.previousClick;
		if (previous !== undefined && now - previous.at <= DOUBLE_CLICK_MS && distance(previous, event) <= CLICK_DISTANCE) {
			this.previousClick = undefined;
			this.startEffect("burst", event.x, event.y, now, BURST_MS);
			return;
		}
		this.previousClick = { x: event.x, y: event.y, at: now };
		this.startEffect("ripple", event.x, event.y, now, RIPPLE_MS);
	}

	private startEffect(kind: TimedEffect["kind"], x: number, y: number, startedAt: number, duration: number): void {
		this.effect = { kind, x, y, startedAt, duration };
		this.ensureTimer();
		this.options.requestRender();
	}

	private ensureTimer(): void {
		if (this.timer !== undefined) return;
		this.timer = setInterval(() => {
			if (this.disposed || !this.options.isActive()) {
				this.resetInteraction();
				return;
			}
			const now = Date.now();
			if (this.press !== undefined && now - this.press.startedAt >= MAX_PRESS_MS) this.press = undefined;
			if (this.effect !== undefined && now - this.effect.startedAt >= this.effect.duration) this.effect = undefined;
			if (this.press === undefined && this.effect === undefined) {
				this.stopTimer();
				this.options.requestRender();
				return;
			}
			this.options.requestRender();
		}, FRAME_MS);
		this.timer.unref();
	}

	private resetInteraction(): void {
		this.press = undefined;
		this.effect = undefined;
		this.previousClick = undefined;
		this.stopTimer();
	}

	private stopTimer(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

/** 解析 Pi fullscreen 使用的 SGR 1006 鼠标协议，坐标转换为 0-based。 */
export function parseSgrMouseEvent(data: string): HomeMouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (match === null) return undefined;
	const button = Number.parseInt(match[1] ?? "", 10);
	const x = Number.parseInt(match[2] ?? "", 10);
	const y = Number.parseInt(match[3] ?? "", 10);
	if (![button, x, y].every(Number.isSafeInteger) || button < 0 || x < 1 || y < 1) return undefined;
	return { button, x: x - 1, y: y - 1, release: match[4] === "m" };
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
	return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
