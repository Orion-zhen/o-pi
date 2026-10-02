import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { runLogin } from "../../src/gui/host/login.ts";
import { GuiDialogs } from "../../src/gui/host/dialogs.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { deferred } from "../helpers/async.ts";

describe("GUI OAuth", () => {
	it("浏览器回调完成后关闭备用授权码输入框并结束登录", async () => {
		const events: GuiEvent[] = [];
		const dialogs = new GuiDialogs((event) => events.push(event), () => 0, { get: () => "", set: () => {} });
		const callback = deferred<void>();
		const ready = deferred<void>();
		const controller = new AbortController();
		const login = runLogin({ login: async (_provider, _type, interaction: AuthInteraction) => {
			const manual = new AbortController();
			interaction.notify({ type: "auth_url", url: "https://example.com/oauth" });
			const pending = interaction.prompt({ type: "manual_code", message: "Redirect URL", signal: manual.signal }).catch(() => undefined);
			ready.resolve();
			await callback.promise;
			manual.abort();
			await pending;
			return { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 10000 };
		} }, "test", "oauth", dialogs, (event) => events.push(event), controller.signal, randomUUID);
		await ready.promise;
		expect(events.some((event) => event.type === "auth")).toBe(true);
		callback.resolve();
		await login;
		expect(dialogs.list()).toEqual([]);
		expect(dialogs.notices).toEqual([expect.objectContaining({ text: "test 登录成功。" })]);
	});

	it("取消登录会关闭输入框并结束等待", async () => {
		const controller = new AbortController();
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const ready = deferred<void>();
		const login = runLogin({ login: async (_provider, _type, interaction) => {
			const pending = interaction.prompt({ type: "manual_code", message: "Redirect URL" });
			ready.resolve();
			await pending;
			throw new Error("不应继续");
		} }, "test", "oauth", dialogs, () => {}, controller.signal, randomUUID);
		await ready.promise;
		controller.abort();
		await expect(login).rejects.toThrow("登录已取消。");
		expect(dialogs.list()).toEqual([]);
		expect(dialogs.notices).toEqual([]);
	});
});
