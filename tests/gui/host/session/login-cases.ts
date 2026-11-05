import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import { deferred } from "../../../helpers/async.ts";

export function loginTests(context: () => { host: GuiClient; events: GuiEvent[] }) {
	describe("GUI 登录边界", () => {
		it.each(["cancelLogin", "input"])("%s 取消登录静默结束并释放交互状态", async (source) => {
			const { host, events } = context();
			const login = host.dispatch({ action: "login", provider: "gui-fixture", type: "api_key" });
			await expect.poll(() => host.execution.dialogs.list().length).toBe(1);
			const dialog = host.execution.dialogs.list()[0];
			if (!dialog) throw new Error("缺少凭据输入");
			await host.dispatch(source === "cancelLogin" ? { action: "cancelLogin" } : { action: "dialog", id: dialog.id, value: null });
			await expect(login).resolves.toBeUndefined();
			expect(host.execution.dialogs.list()).toEqual([]);
			expect(events.filter((event) => event.type === "auth").at(-1)).toEqual({ type: "auth", value: null });
			expect(events.filter((event) => event.type === "feedback")).toEqual([]);
		});

		it("凭据已提交后的取消不会掩盖 SDK 同步失败", async () => {
			const { host, events } = context();
			const models = host.runtime.services.modelRuntime;
			const synchronizing = deferred<void>();
			const release = deferred<void>();
			models.registerNativeProvider({
				id: "login-fixture", name: "Login fixture", getModels: () => [],
				auth: { apiKey: {
					name: "API Key", login: async () => ({ type: "api_key", key: "saved" }), resolve: async () => undefined,
				} },
				refreshModels: async ({ credential }) => {
					if (!credential) return;
					synchronizing.resolve();
					await release.promise;
				},
				stream: () => { throw new Error("本测试不调用模型"); },
				streamSimple: () => { throw new Error("本测试不调用模型"); },
			});
			const login = host.dispatch({ action: "login", provider: "login-fixture", type: "api_key" });
			const outcome = expect(login).rejects.toBeInstanceOf(CredentialSynchronizationError);
			try {
				await synchronizing.promise;
				await host.dispatch({ action: "cancelLogin" });
			} finally { release.resolve(); }
			await outcome;
			expect(await models.listCredentials()).toContainEqual({ providerId: "login-fixture", type: "api_key" });
			expect(events.filter((event) => event.type === "auth").at(-1)).toEqual({ type: "auth", value: null });
			expect(events.filter((event) => event.type === "feedback")).toEqual([]);
		});
	});
}
