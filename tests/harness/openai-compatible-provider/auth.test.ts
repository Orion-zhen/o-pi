import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createProviderAuth } from "../../../src/harness/openai-compatible-provider/auth.js";
import { loadProvider } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();
const activeSignal = new AbortController().signal;

describe("openai-compatible-provider auth", () => {
	it("认证检查和解析支持环境变量、无密钥配置及取消", async () => {
		const ctx = {
			env: async (name: string) => ({ KEY: "sk-test", TOKEN: "header-token" })[name],
			fileExists: async () => false,
		};
		const configured = createProviderAuth("gateway", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "$KEY",
			headers: { "X-Token": "$TOKEN" },
		});
		const configuredResult = await configured.resolve({ ctx, signal: activeSignal });
		if (!configuredResult) throw new Error("configured auth unexpectedly missing");
		expect(configuredResult).toMatchObject({
			auth: { apiKey: "sk-test" },
			source: "KEY",
		});

		const keyless = createProviderAuth("local", {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
		});
		const keylessResult = await keyless.resolve({ ctx, signal: activeSignal });
		if (!keylessResult) throw new Error("keyless auth unexpectedly missing");
		expect(keylessResult.source).toBe("keyless provider");

		const incomplete = createProviderAuth("incomplete", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "sk-test",
			headers: { "X-Account": "$MISSING_ACCOUNT" },
		});
		await expect(incomplete.check?.({ ctx, signal: activeSignal })).resolves.toBeUndefined();
		await expect(configured.resolve({ ctx, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
	});

	it.each([
		[{ apiKey: "sk-key" }, {}, "Bearer sk-key", null],
		[{ apiKey: "EMPTY" }, {}, null, null],
		[{ apiKey: "EMPTY" }, { apiKey: "sk-request" }, "Bearer sk-request", null],
		[{ apiKey: undefined, headers: { authorization: "$HEADER" } }, { env: { HEADER: "Custom token" } }, "Custom token", null],
		[{ apiKey: "sk-key", headers: { "CF-AIG-Authorization": "Custom token" } }, {}, null, "Custom token"],
		[{ apiKey: "EMPTY", headers: { authorization: "Custom token" } }, { headers: { AUTHORIZATION: null } }, null, null],
	] as const)("认证字段在实际请求中保持无密钥、自定义头和调用方覆盖语义 %#", async (config, options, authorization, cfAuthorization) => {
		const provider = await loadProvider(temp.path, config);
		const model = provider.getModels()[0];
		if (!model) throw new Error("provider model missing");
		const models = createModels();
		models.setProvider(provider);
		let headers: Headers | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			headers = new Headers(init?.headers);
			return new Response('{"error":"stop"}', { status: 400 });
		});
		for await (const _event of models.streamSimple(model, {
			messages: [{ role: "user", content: "test", timestamp: 0 }],
		}, options)) {}
		expect(headers?.get("Authorization")).toBe(authorization);
		expect(headers?.get("CF-AIG-Authorization")).toBe(cfAuthorization);
	});

	it("并发请求的环境变量、密钥和请求头互不串用", async () => {
		const provider = await loadProvider(temp.path, {
			apiKey: "$KEY", headers: { "X-Account": "$ACCOUNT" },
			models: [{ id: "m", headers: { "X-Model": "$MODEL_HEADER" } }],
		});
		const model = provider.getModels()[0];
		if (!model) throw new Error("provider model missing");
		const models = createModels();
		models.setProvider(provider);
		const requests: (string | null)[][] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const headers = new Headers(init?.headers);
			requests.push([headers.get("Authorization"), headers.get("X-Account"), headers.get("X-Model")]);
			return new Response('{"error":"stop"}', { status: 400 });
		});
		await Promise.all(["one", "two"].map(async (id) => {
			for await (const _event of models.streamSimple(model, {
				messages: [{ role: "user", content: "test", timestamp: 0 }],
			}, { env: { KEY: id, ACCOUNT: id, MODEL_HEADER: id } })) {}
		}));
		expect(requests.sort()).toEqual([["Bearer one", "one", "one"], ["Bearer two", "two", "two"]]);
	});

	it("auth check 不执行命令，resolve 才在请求边界执行并缓存结果", async () => {
		const marker = path.join(temp.path, "auth-command-ran");
		const resolver = path.join(temp.path, "resolve-key.cjs");
		await writeFile(
			resolver,
			`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran"); process.stdout.write("sk-command");`,
		);
		const auth = createProviderAuth("command", {
			baseUrl: "https://gateway.test/v1",
			apiKey: `!"${process.execPath}" "${resolver}"`,
		});
		const ctx = { env: async () => undefined, fileExists: async () => false };

		await expect(auth.check?.({ ctx, signal: activeSignal })).resolves.toMatchObject({ type: "api_key" });
		await expect(readFile(marker, "utf8")).rejects.toThrow();
		await expect(auth.resolve({ ctx, signal: activeSignal })).resolves.toMatchObject({ auth: { apiKey: "sk-command" } });
		await expect(auth.resolve({ ctx, signal: activeSignal })).resolves.toMatchObject({ auth: { apiKey: "sk-command" } });
		expect(await readFile(marker, "utf8")).toBe("ran");
	});
});
