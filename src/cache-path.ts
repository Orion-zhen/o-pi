import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** User-level regenerable cache root shared by lightweight control-plane modules. */
export function userCachePath(...segments: string[]): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, "cache", ...segments);
}

export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}
