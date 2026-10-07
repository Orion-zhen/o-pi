import { app, screen, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface WindowState extends Rectangle {
	maximized: boolean;
}

const minWidth = 420;
const minHeight = 500;

function readState(file: string): WindowState | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof value !== "object" || value === null
			|| !("x" in value) || typeof value.x !== "number" || !Number.isSafeInteger(value.x)
			|| !("y" in value) || typeof value.y !== "number" || !Number.isSafeInteger(value.y)
			|| !("width" in value) || typeof value.width !== "number" || !Number.isSafeInteger(value.width) || value.width <= 0
			|| !("height" in value) || typeof value.height !== "number" || !Number.isSafeInteger(value.height) || value.height <= 0
			|| !("maximized" in value) || typeof value.maximized !== "boolean")
			return undefined;
		return { x: value.x, y: value.y, width: value.width, height: value.height, maximized: value.maximized };
	} catch {
		return undefined;
	}
}

function visibleBounds(state: WindowState): Rectangle {
	const area = screen.getDisplayMatching(state).workArea;
	const width = Math.max(minWidth, Math.min(state.width, area.width));
	const height = Math.max(minHeight, Math.min(state.height, area.height));
	return {
		x: Math.max(area.x, Math.min(state.x, area.x + area.width - width)),
		y: Math.max(area.y, Math.min(state.y, area.y + area.height - height)),
		width,
		height,
	};
}

export function createDesktopWindowState(): {
	options: BrowserWindowConstructorOptions;
	install: (window: BrowserWindow) => void;
} {
	const file = path.join(app.getPath("userData"), "window-state.json");
	const state = readState(file);
	return {
		options: { ...(state ? visibleBounds(state) : { width: 1200, height: 820 }), minWidth, minHeight },
		install(window) {
			if (state?.maximized) window.maximize();
			window.on("close", () => {
				try {
					const next: WindowState = { ...window.getNormalBounds(), maximized: window.isMaximized() };
					mkdirSync(path.dirname(file), { recursive: true });
					writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
				} catch (error) {
					console.error("无法保存窗口状态:", error);
				}
			});
		},
	};
}
