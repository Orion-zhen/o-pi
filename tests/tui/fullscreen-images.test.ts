import { createCanvas } from "@napi-rs/canvas";
import {
	Box, Container, Editor, Image, ScrollView, Text, TuiAltScreen, TuiMainScreen, VStack,
	type TUI,
	getCellDimensions, resetCapabilitiesCache, setCapabilities, setCellDimensions,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFullscreenImageFix } from "../../src/tui/fullscreen-images.js";
import { RecordingTerminal } from "./recording-terminal.js";
import { createInteractiveTuiReference } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";

const theme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text, selectedText: (text: string) => text,
		description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text,
	},
};
let terminal: RecordingTerminal;
let ui: TuiAltScreen;
let restore: () => void;
let previousCell = getCellDimensions();

beforeEach(() => {
	previousCell = getCellDimensions();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	terminal = new RecordingTerminal();
	ui = new TuiAltScreen(terminal, true);
	restore = installFullscreenImageFix(ui);
});
afterEach(() => {
	ui.stop();
	restore();
	setCellDimensions(previousCell);
	resetCapabilitiesCache();
});

function image(id: number, noise = false): Image {
	const canvas = createCanvas(144, 108);
	const context = canvas.getContext("2d");
	if (noise) {
		const pixels = context.createImageData(144, 108);
		let seed = 17;
		for (let offset = 0; offset < pixels.data.length; offset += 4) {
			for (let channel = 0; channel < 3; channel++) {
				seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
				pixels.data[offset + channel] = seed >>> 24;
			}
			pixels.data[offset + 3] = 255;
		}
		context.putImageData(pixels, 0, 0);
	} else {
		context.fillStyle = "red";
		context.fillRect(0, 0, 144, 108);
	}
	return new Image(canvas.toBuffer("image/png").toString("base64"), "image/png", { fallbackColor: (text) => text }, {
		imageId: id, maxWidthCells: 16, maxHeightCells: 6,
	});
}

function start(): string {
	ui.start();
	ui.renderNow();
	return terminal.take();
}

function expectPaintLast(frame: string): void {
	const imageStart = frame.search(/\x1b_Ga=(?:T|p),/);
	expect(imageStart).toBeGreaterThanOrEqual(0);
	expect(/\x1b\[(?:[012]?K|[23]J)/.test(frame.slice(imageStart))).toBe(false);
	expect(frame).toContain("\x1b7");
	expect(frame).toContain("\x1b8\x1b[?2026l");
}

describe("Pi 全屏图片输出适配", () => {
	it("先完成清行与背景绘制，再画多行图片，保留硬件光标", () => {
		const editor = new Editor(ui, theme);
		editor.setText("中文输入");
		ui.setLayoutRoot(new VStack([image(17), editor]));
		ui.setFocus(editor);
		const frame = start();
		expectPaintLast(frame);
		expect(frame).toContain("r=6,i=17");
		expect(frame).toContain("\x1b[?25h");
	});

	it("保留大图片的连续分块传输", () => {
		ui.addChild(image(18, true));
		const frame = start();
		expectPaintLast(frame);
		expect(frame.match(/\x1b_Gm=1;/g)?.length).toBeGreaterThan(1);
		expect(frame).toMatch(/\x1b\\\x1b_Gm=/);
	});

	it("滚动保留图片裁剪，并复用上游的 placement 缓存", () => {
		const content = new Container();
		content.addChild(new Text("标题", 0, 0));
		content.addChild(image(19));
		content.addChild(new Text("正文\n".repeat(50), 0, 0));
		const view = new ScrollView(content, { primary: true, scrollbar: "always" });
		ui.setLayoutRoot(view);
		expectPaintLast(start());
		terminal.send("\x1b[<64;10;5M");
		ui.renderNow();
		terminal.take();
		terminal.send("\x1b[<65;10;5M");
		expect(view.scrollTop).toBe(1);
		for (let step = 0; step < 4; step++) terminal.send("\x1b[<65;10;5M");
		ui.renderNow();
		const frame = terminal.take();
		expect(view.scrollTop).toBe(5);
		expectPaintLast(frame);
		expect(frame).toMatch(/\x1b_Ga=p,[^\x1b]*i=19/);
		expect(frame).toContain("y=72,h=36,r=2");
	});

	it("滚动条差分刷新补绘受影响的图片，不重新上传", () => {
		const content = new Container();
		content.addChild(image(27));
		content.addChild(new Text("正文\n".repeat(50), 0, 0));
		const view = new ScrollView(content, { primary: true, scrollbar: "always" });
		ui.setLayoutRoot(view);
		start();
		view.setScrollbarActive(true);
		ui.renderNow();
		const frame = terminal.take();
		expectPaintLast(frame);
		expect(frame).toContain("\x1b_Ga=p,q=2,C=1,c=16,r=6,i=27");
		expect(frame).not.toContain("\x1b_Ga=T");
	});

	it("图片之外的文字更新不重复放置图片", () => {
		const status = new Text("等待", 0, 0);
		ui.addChild(image(28));
		ui.addChild(status);
		start();
		status.setText("完成");
		ui.renderNow();
		expect(terminal.take()).not.toContain("\x1b_G");
	});

	it("窗口缩放及强制刷新都保持先清后画", () => {
		ui.addChild(image(20));
		start();
		terminal.setSize(60, 18);
		ui.renderNow();
		expectPaintLast(terminal.take());
		ui.renderNow(true);
		expectPaintLast(terminal.take());
	});

	it("多张图片保留各自的行列位置和内边距", () => {
		const box = new Box(3, 0);
		box.addChild(image(22));
		ui.addChild(new Text("标题", 0, 0));
		ui.addChild(box);
		ui.addChild(image(23));
		const frame = start();
		expectPaintLast(frame);
		expect(frame).toMatch(/\x1b\[2;4H\x1b_Ga=T,[^;]*i=22/);
		expect(frame).toMatch(/\x1b\[8;1H\x1b_Ga=T,[^;]*i=23/);
	});

	it("关闭遮盖图片的弹窗后重新绘制图片并恢复焦点", () => {
		const editor = new Editor(ui, theme);
		ui.setLayoutRoot(new VStack([image(24), editor]));
		ui.setFocus(editor);
		start();
		const overlay = ui.showOverlay(new Text("弹窗\n".repeat(7), 0, 0), { width: "100%", row: 0, col: 0 });
		ui.renderNow();
		terminal.take();
		overlay.hide();
		ui.renderNow();
		expectPaintLast(terminal.take());
		expect(editor.focused).toBe(true);
	});

	it("Pi 模式切换复用终端时只改写 fullscreen，释放后恢复原 write", () => {
		restore();
		const originalWrite = terminal.write;
		let active: TUI = new TuiMainScreen(terminal);
		const reference = createInteractiveTuiReference(() => active);
		restore = installFullscreenImageFix(reference);
		active.addChild(image(25));
		active.start();
		active.renderNow();
		const regularFrame = terminal.take();
		expect(regularFrame).toContain("i=25");
		expect(regularFrame).not.toContain("\x1b7");
		active.stop({ preserveScreen: true });
		terminal.take();
		active = ui;
		ui.addChild(image(26));
		expectPaintLast(start());
		restore();
		expect(terminal.write).toBe(originalWrite);
		ui.renderNow(true);
		const originalFrame = terminal.take();
		const imageStart = originalFrame.indexOf("\x1b_Ga=p");
		expect(imageStart).toBeGreaterThanOrEqual(0);
		expect(originalFrame.slice(imageStart).includes("\x1b[2K")).toBe(true);
	});

	it("图片移除和退出的删除指令不被延后或丢失", () => {
		ui.addChild(image(21));
		start();
		ui.clear();
		ui.renderNow();
		const cleared = terminal.take();
		expect(cleared).toContain("\x1b_Ga=d");
		expect(cleared).not.toMatch(/\x1b_Ga=(?:T|p),/);
		ui.stop();
		const stopped = terminal.take();
		expect(stopped).toContain("\x1b[?1006l");
		expect(stopped).toContain("\x1b[?1049l");
		expect(stopped).toContain("\x1b[?25h");
	});
});
