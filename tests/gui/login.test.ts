import { describe, expect, it } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { runLogin } from "../../src/gui/host/login.ts";
import { GuiDialogs } from "../../src/gui/host/dialogs.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { deferred } from "../helpers/async.ts";

describe("GUI OAuth", () => {
	it("回调等待不产生输入弹窗，回调完成后结束登录", async () => {
		const events: GuiEvent[] = [];
		const dialogs = new GuiDialogs((event) => events.push(event));
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
		} }, "test", "oauth", dialogs, (event) => events.push(event), controller.signal);
		await ready.promise;
		expect(dialogs.list()).toEqual([]);
		expect(events.some((event) => event.type === "auth")).toBe(true);
		callback.resolve();
		await login;
		expect(dialogs.notices.at(-1)?.text).toBe("test 登录成功。");
	});

	it("取消登录会终止隐藏的手动输入等待", async () => {
		const controller = new AbortController();
		const dialogs = new GuiDialogs(() => {});
		const ready = deferred<void>();
		const login = runLogin({ login: async (_provider, _type, interaction) => {
			const pending = interaction.prompt({ type: "manual_code", message: "Redirect URL" });
			ready.resolve();
			await pending;
			throw new Error("不应继续");
		} }, "test", "oauth", dialogs, () => {}, controller.signal);
		await ready.promise;
		controller.abort();
		await expect(login).rejects.toThrow();
		expect(dialogs.list()).toEqual([]);
		expect(dialogs.notices).toEqual([]);
	});
});
