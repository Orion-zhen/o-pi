import path from "node:path";
import type { ExtensionContext, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { statusIcon } from "../components/icons.ts";
import { joinParts } from "../components/text.ts";
import type { TuiConfig, TuiRunStatus, TuiSnapshot } from "./types.ts";

export const TUI_STATUS_KEY = "o-pi:tui";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function workingIndicatorOptions(config: TuiConfig, theme: Pick<Theme, "fg">): WorkingIndicatorOptions {
	switch (config.chrome.working_indicator) {
		case "off": return { frames: [] };
		case "dot": return { frames: [theme.fg("warning", statusIcon("running"))] };
		case "spinner": return { frames: SPINNER_FRAMES.map((frame) => theme.fg("warning", frame)), intervalMs: 80 };
	}
}

export function formatTitle(snapshot: Pick<TuiSnapshot, "cwd" | "sessionName" | "git" | "modelId" | "status">): string {
	return joinParts(["π o-pi", snapshot.sessionName, path.basename(snapshot.cwd), snapshot.git, snapshot.modelId, snapshot.status], " · ");
}

export function formatStatus(status: TuiRunStatus, theme: Pick<Theme, "fg">): string {
	if (status === "running") return theme.fg("warning", `${statusIcon("running")} running`);
	if (status === "waiting") return theme.fg("warning", `${statusIcon("warning")} waiting`);
	return theme.fg("success", `${statusIcon("success")} ready`);
}

export function clearChrome(ctx: Pick<ExtensionContext, "ui" | "cwd">): void {
	ctx.ui.setStatus(TUI_STATUS_KEY, undefined);
	ctx.ui.setFooter(undefined);
	ctx.ui.setHeader(undefined);
	ctx.ui.setWorkingIndicator();
	ctx.ui.setTitle(formatTitle({ cwd: ctx.cwd, status: "ready" }));
}
