import type { GuiConnection } from "./connection.ts";
import type { StorageGroup } from "../storage.ts";

export interface DesktopAppearance { theme: "system" | "light" | "dark"; transparent: boolean }
export type DesktopMaterial = "vibrancy" | "acrylic" | "compositor" | "none";
export interface DesktopBridge extends Omit<GuiConnection, "subscribe"> {
	reportDiagnostic(value: import("../diagnostics/diagnostics.ts").GuiDiagnostic): Promise<import("../diagnostics/diagnostics.ts").DiagnosticReceipt>;
	readStorage(): Promise<StorageGroup>;
	clearStorage(ids: string[]): Promise<void>;
	/** 返回平台支持的背景材质，不受当前开关或辅助功能设置影响。 */
	setAppearance(value: DesktopAppearance): Promise<DesktopMaterial>;
	subscribe(listener: (delivery: import("./sync.ts").GuiDelivery) => void): () => void;
	acknowledge(id: number): void;
	chooseDirectory(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
	openFile(cwd: string, path: string): Promise<void>;
}
