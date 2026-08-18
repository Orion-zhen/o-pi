import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HomePointerController,
	parseSgrMouseEvent,
	type HomePointerInput,
} from "../../src/tui/home-pointer.js";

class FakePointerInput implements HomePointerInput {
	readonly isTTY = true;
	private readonly listeners = new Set<(data: string | Buffer) => void>();

	on(_event: "data", listener: (data: string | Buffer) => void): this {
		this.listeners.add(listener);
		return this;
	}

	off(_event: "data", listener: (data: string | Buffer) => void): this {
		this.listeners.delete(listener);
		return this;
	}

	emit(data: string | Buffer): void {
		for (const listener of this.listeners) listener(data);
	}

	listenerCount(): number {
		return this.listeners.size;
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Home pointer feedback", () => {
	it("解析 SGR 1006 并转为零基坐标", () => {
		expect(parseSgrMouseEvent("\x1b[<0;41;9M")).toEqual({ button: 0, x: 40, y: 8, release: false });
		expect(parseSgrMouseEvent("\x1b[<0;41;9m")).toEqual({ button: 0, x: 40, y: 8, release: true });
		expect(parseSgrMouseEvent("\x1b[<0;0;9M")).toBeUndefined();
		expect(parseSgrMouseEvent("plain text")).toBeUndefined();
	});

	it("跨 stdin 数据块识别点击，并将连续双击升级为粒子爆发", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const input = new FakePointerInput();
		const requestRender = vi.fn();
		const controller = new HomePointerController({
			effects: "click-hold",
			isActive: () => true,
			requestRender,
			input,
		});

		input.emit("\x1b[<0;40");
		input.emit(";10M");
		expect(controller.getFrame()).toMatchObject({ kind: "press", x: 39, y: 9 });
		input.emit("\x1b[<0;40;10m");
		expect(controller.getFrame()).toMatchObject({ kind: "ripple", x: 39, y: 9 });

		vi.advanceTimersByTime(100);
		input.emit("\x1b[<0;40;10M");
		input.emit("\x1b[<0;40;10m");
		expect(controller.getFrame()).toMatchObject({ kind: "burst", x: 39, y: 9 });
		expect(requestRender).toHaveBeenCalled();

		controller.dispose();
		expect(input.listenerCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("长按蓄力，松开后爆炸并在有限时间内停止", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const input = new FakePointerInput();
		const controller = new HomePointerController({
			effects: "click-hold",
			isActive: () => true,
			requestRender: vi.fn(),
			input,
		});

		input.emit("\x1b[<0;24;7M");
		vi.advanceTimersByTime(500);
		expect(controller.getFrame()).toMatchObject({ kind: "charge", x: 23, y: 6 });
		input.emit("\x1b[<0;24;7m");
		expect(controller.getFrame()).toMatchObject({ kind: "explode", x: 23, y: 6 });

		vi.advanceTimersByTime(900);
		expect(controller.getFrame()).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		controller.dispose();
	});

	it("拖动、滚轮和右键不触发效果，避免干扰原生选择与滚动", () => {
		vi.useFakeTimers();
		const input = new FakePointerInput();
		const controller = new HomePointerController({
			effects: "click-hold",
			isActive: () => true,
			requestRender: vi.fn(),
			input,
		});

		input.emit("\x1b[<64;10;5M");
		input.emit("\x1b[<2;10;5M");
		expect(controller.getFrame()).toBeUndefined();

		input.emit("\x1b[<0;10;5M");
		input.emit("\x1b[<32;15;5M");
		input.emit("\x1b[<0;15;5m");
		expect(controller.getFrame()).toBeUndefined();
		controller.dispose();
	});

	it("关闭配置或非 TTY 时不安装输入监听", () => {
		const disabledInput = new FakePointerInput();
		const disabled = new HomePointerController({
			effects: "off",
			isActive: () => true,
			requestRender: vi.fn(),
			input: disabledInput,
		});
		const nonTtyInput: HomePointerInput = {
			isTTY: false,
			on: () => undefined,
			off: () => undefined,
		};
		const nonTty = new HomePointerController({
			effects: "click-hold",
			isActive: () => true,
			requestRender: vi.fn(),
			input: nonTtyInput,
		});

		expect(disabledInput.listenerCount()).toBe(0);
		expect(disabled.getFrame()).toBeUndefined();
		expect(nonTty.getFrame()).toBeUndefined();
		disabled.dispose();
		nonTty.dispose();
	});
});
