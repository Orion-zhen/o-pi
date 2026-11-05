import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type OAuthAuth, type ProviderAuth } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runLogin } from "../../../../src/gui/host/session/login.ts";
import { GuiDialogs } from "../../../../src/gui/host/session/dialogs.ts";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import { deferred } from "../../../helpers/async.ts";

const credential = { type: "oauth" as const, access: "token", refresh: "refresh", expires: Date.now() + 3600000 };
const oauth = (login: OAuthAuth["login"]): ProviderAuth => ({ oauth: {
	name: "Test OAuth", login, refresh: async () => credential, toAuth: async () => ({ apiKey: "token" }),
} });

async function setup(auth: ProviderAuth) {
	const credentials = new InMemoryCredentialStore();
	const models = await ModelRuntime.create({ modelsPath: null, credentials, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
	models.registerNativeProvider({
		id: "test", name: "Test", auth, getModels: () => [],
		stream: () => { throw new Error("本测试不调用模型"); },
		streamSimple: () => { throw new Error("本测试不调用模型"); },
	});
	const events: GuiEvent[] = [];
	const emit = (event: GuiEvent) => { events.push(event); };
	const dialogs = new GuiDialogs(emit, () => 0, { get: () => "", set: () => {} });
	return { models, credentials, events, emit, dialogs };
}

describe("GUI 使用 SDK 原生登录流程", () => {
	it.each(["browser", null])("选择 OAuth 登录方式或取消：%s", async (value) => {
		const ready = deferred<void>();
		const { models, credentials, dialogs, emit } = await setup(oauth(async (interaction) => {
			const pending = interaction.prompt({ type: "select", message: "选择登录方式", options: [
				{ id: "browser", label: "Browser login" }, { id: "copy_code", label: "Copy code login" },
			] });
			ready.resolve();
			expect(await pending).toBe("browser");
			return credential;
		}));
		const controller = new AbortController();
		const login = runLogin(models, "test", "oauth", dialogs, emit, controller, randomUUID);
		await ready.promise;
		const [dialog] = dialogs.list();
		if (dialog?.kind !== "select") throw new Error("缺少登录方式选择");
		expect(dialog.options).toEqual([{ label: "Browser login [browser]", value: "browser" }, { label: "Copy code login [copy_code]", value: "copy_code" }]);
		expect(() => dialogs.respond(dialog.id, "forged")).toThrow("无效选项。");
		expect(dialogs.list()).toEqual([dialog]);
		dialogs.respond(dialog.id, value);
		if (value === null) {
			await expect(login).rejects.toMatchObject({ name: "AbortError" });
			expect(controller.signal.aborted).toBe(true);
			expect(await credentials.read("test")).toBeUndefined();
		} else {
			await login;
			expect(controller.signal.aborted).toBe(false);
			expect(await credentials.read("test")).toEqual(credential);
		}
		expect(dialogs.list()).toEqual([]);
	});

	it("浏览器回调完成后，SDK 关闭备用输入并保存凭据", async () => {
		const callback = deferred<void>();
		const ready = deferred<void>();
		const { models, credentials, dialogs, emit, events } = await setup(oauth(async (interaction) => {
			const manual = new AbortController();
			interaction.notify({ type: "auth_url", url: "https://example.com/oauth" });
			const pending = interaction.prompt({ type: "manual_code", message: "Redirect URL", signal: manual.signal }).catch(() => undefined);
			ready.resolve();
			await callback.promise;
			manual.abort();
			await pending;
			return credential;
		}));
		const controller = new AbortController();
		const login = runLogin(models, "test", "oauth", dialogs, emit, controller, randomUUID);
		await ready.promise;
		callback.resolve();
		await login;
		expect(controller.signal.aborted).toBe(false);
		expect(dialogs.list()).toEqual([]);
		expect(await credentials.read("test")).toEqual(credential);
		expect(events).toContainEqual({ type: "feedback", message: "已连接 test", tone: "success" });
	});

	it("取消整个登录时保留 SDK 的取消原因，不保存凭据或发送成功反馈", async () => {
		const ready = deferred<void>();
		const { models, credentials, dialogs, emit, events } = await setup(oauth(async (interaction) => {
			const pending = interaction.prompt({ type: "manual_code", message: "Redirect URL" });
			ready.resolve();
			await pending;
			return credential;
		}));
		const controller = new AbortController();
		const login = runLogin(models, "test", "oauth", dialogs, emit, controller, randomUUID);
		await ready.promise;
		controller.abort();
		await expect(login).rejects.toBe(controller.signal.reason);
		expect(dialogs.list()).toEqual([]);
		expect(await credentials.read("test")).toBeUndefined();
		expect(events.some((event) => event.type === "feedback")).toBe(false);
	});

	it("取消凭据输入终止 SDK 登录，重试保存凭据但不重复通知", async () => {
		const { models, credentials, dialogs, emit, events } = await setup({ apiKey: {
			name: "Test API Key", login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "API Key" }) }),
			resolve: async () => undefined,
		} });
		const controller = new AbortController();
		const login = runLogin(models, "test", "api_key", dialogs, emit, controller, randomUUID);
		await expect.poll(() => dialogs.list().length).toBe(1);
		const dialog = dialogs.list()[0];
		if (!dialog) throw new Error("缺少凭据输入");
		dialogs.respond(dialog.id, null);
		await expect(login).rejects.toMatchObject({ name: "AbortError" });
		expect(controller.signal.aborted).toBe(true);
		expect(await credentials.read("test")).toBeUndefined();
		const retry = runLogin(models, "test", "api_key", dialogs, emit, new AbortController(), randomUUID);
		await expect.poll(() => dialogs.list().length).toBe(1);
		const input = dialogs.list()[0];
		if (!input) throw new Error("缺少重试凭据输入");
		dialogs.respond(input.id, "secret");
		await retry;
		expect(await credentials.read("test")).toEqual({ type: "api_key", key: "secret" });
		expect(events.some((event) => event.type === "feedback")).toBe(false);
	});

	it("提供方登录失败原样交给调用方呈现", async () => {
		const failure = new Error("认证服务不可用");
		const { models, dialogs, emit } = await setup(oauth(async () => { throw failure; }));
		await expect(runLogin(models, "test", "oauth", dialogs, emit, new AbortController(), randomUUID)).rejects.toBe(failure);
	});
});
