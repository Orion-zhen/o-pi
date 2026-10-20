import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { Panel } from "../../src/gui/ui/app/panels.tsx";
import { guiSnapshot } from "./snapshot-fixture.ts";

vi.mock("../../src/gui/ui/components/panel-dialog.tsx", () => ({
	PanelDialog: ({ children }: { children: ReactNode }) => children,
}));

it("认证页只显示 provider 支持的登录入口，已配置状态不影响登录能力", () => {
	const snapshot = guiSnapshot();
	snapshot.providers = [
		{ id: "openai-codex", name: "Codex", apiKey: false, oauth: true, authenticated: true },
		{ id: "key-only", name: "Key only", apiKey: true, oauth: false, authenticated: false },
		{ id: "anthropic", name: "Anthropic", apiKey: true, oauth: true, authenticated: false },
		{ id: "ambient", name: "Ambient", apiKey: false, oauth: false, authenticated: true },
	];
	const { document } = parseHTML(renderToStaticMarkup(<Panel ref={null} panel={{ kind: "auth" }} snapshot={snapshot}
		sessionList={null} send={async () => true} canChangeSession close={() => {}} restoreFocus={() => {}} />));
	expect([...document.querySelectorAll(".list-row")].map((row) =>
		[...row.querySelectorAll("button")].map((button) => button.textContent),
	)).toEqual([
		["OAuth", "退出"],
		["API Key"],
		["API Key", "OAuth"],
		["退出"],
	]);
});
