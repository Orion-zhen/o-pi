import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePointerController } from "../../../../src/tui/views/home/pointer.ts";

let ttyDescriptor: PropertyDescriptor | undefined;
const controllers: HomePointerController[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	// 测试终端事件，不让 Readable.on() 开始读取测试进程的真实输入。
	vi.spyOn(process.stdin, "on").mockImplementation((event, listener) => {
		EventEmitter.prototype.on.call(process.stdin, event, listener);
		return process.stdin;
	});
});

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
	if (ttyDescriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
	else Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Home pointer feedback", () => {
	it("跨 stdin 数据块识别点击，坐标转为零基，连续双击升级为粒子爆发", () => {
		const requestRender = vi.fn();
		const listeners = process.stdin.listenerCount("data");
		const controller = createController(requestRender);

		input("\x1b[<0;40");
		input(";10M");
		expect(controller.getFrame()).toMatchObject({ kind: "press", x: 39, y: 9 });
		input("\x1b[<0;40;10m");
		expect(controller.getFrame()).toMatchObject({ kind: "ripple", x: 39, y: 9 });
		vi.advanceTimersByTime(100);
		input("\x1b[<0;40;10M");
		input("\x1b[<0;40;10m");
		expect(controller.getFrame()).toMatchObject({ kind: "burst", x: 39, y: 9 });
		expect(requestRender).toHaveBeenCalled();

		controller.dispose();
		expect(process.stdin.listenerCount("data")).toBe(listeners);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("非法坐标和普通文本不触发鼠标效果", () => {
		const requestRender = vi.fn();
		const controller = createController(requestRender);
		input("\x1b[<0;0;9M");
		input("plain text");
		expect(controller.getFrame()).toBeUndefined();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("长按蓄力，松开后爆炸并在有限时间内停止", () => {
		const controller = createController();
		input("\x1b[<0;24;7M");
		vi.advanceTimersByTime(500);
		expect(controller.getFrame()).toMatchObject({ kind: "charge", x: 23, y: 6 });
		input("\x1b[<0;24;7m");
		expect(controller.getFrame()).toMatchObject({ kind: "explode", x: 23, y: 6 });
		vi.advanceTimersByTime(900);
		expect(controller.getFrame()).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("拖动、滚轮和右键不触发效果，避免干扰原生选择与滚动", () => {
		const controller = createController();
		input("\x1b[<64;10;5M");
		input("\x1b[<2;10;5M");
		expect(controller.getFrame()).toBeUndefined();
		input("\x1b[<0;10;5M");
		input("\x1b[<32;15;5M");
		input("\x1b[<0;15;5m");
		expect(controller.getFrame()).toBeUndefined();
	});

	it("关闭配置或非 TTY 时不安装输入监听", () => {
		const listeners = process.stdin.listenerCount("data");
		const disabled = new HomePointerController({ effects: "off", isActive: () => true, requestRender: vi.fn() });
		controllers.push(disabled);
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		const nonTty = createController();
		expect(process.stdin.listenerCount("data")).toBe(listeners);
		expect(disabled.getFrame()).toBeUndefined();
		expect(nonTty.getFrame()).toBeUndefined();
	});
});

function createController(requestRender: () => void = vi.fn()): HomePointerController {
	const controller = new HomePointerController({ effects: "click-hold", isActive: () => true, requestRender });
	controllers.push(controller);
	return controller;
}

function input(data: string): void {
	process.stdin.emit("data", data);
}
