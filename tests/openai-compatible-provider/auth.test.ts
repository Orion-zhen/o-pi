import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProviderAuth, redactApiKey, resolveRefreshAuth } from "../../src/openai-compatible-provider/index.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider auth", () => {
	it("原生 auth 正确解析 env/header，并让 EMPTY provider 真正无 Authorization", async () => {
		const ctx = {
			env: async (name: string) => ({ KEY: "sk-test", TOKEN: "header-token" })[name],
			fileExists: async () => false,
		};
		const configured = createProviderAuth("gateway", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "$KEY",
			headers: { "X-Token": "$TOKEN" },
		});
		await expect(configured.resolve({ ctx })).resolves.toMatchObject({
			auth: { apiKey: "sk-test", headers: { "X-Token": "header-token" } },
			source: "KEY",
		});

		const keyless = createProviderAuth("local", {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
		});
		await expect(keyless.resolve({ ctx })).resolves.toMatchObject({
			auth: { apiKey: "unused", headers: { Authorization: null } },
			source: "keyless provider",
		});
		const keylessConfig = {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
		} as const;
		expect(resolveRefreshAuth("local", keylessConfig, { type: "api_key", key: "sk-runtime" })).toMatchObject({
			apiKey: "sk-runtime",
			keyless: false,
		});
		expect(resolveRefreshAuth("local", keylessConfig, { type: "api_key", key: "unused" })).toMatchObject({
			apiKey: "unused",
			keyless: false,
		});

		const incomplete = createProviderAuth("incomplete", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "sk-test",
			headers: { "X-Account": "$MISSING_ACCOUNT" },
		});
		await expect(incomplete.check?.({ ctx })).resolves.toBeUndefined();
	});

	it("auth check 不执行命令，resolve 才在请求边界执行并缓存结果", async () => {
		const marker = path.join(temp.path, "auth-command-ran");
		const auth = createProviderAuth("command", {
			baseUrl: "https://gateway.test/v1",
			apiKey: `!printf ran >> ${marker}; printf sk-command`,
		});
		const ctx = { env: async () => undefined, fileExists: async () => false };

		await expect(auth.check?.({ ctx })).resolves.toMatchObject({ type: "api_key" });
		await expect(readFile(marker, "utf8")).rejects.toThrow();
		await expect(auth.resolve({ ctx })).resolves.toMatchObject({ auth: { apiKey: "sk-command" } });
		await expect(auth.resolve({ ctx })).resolves.toMatchObject({ auth: { apiKey: "sk-command" } });
		expect(await readFile(marker, "utf8")).toBe("ran");
	});

	it("apiKey 脱敏规则覆盖 literal、env、command、EMPTY 和 missing", () => {
		expect(redactApiKey("sk-secret")).toBe("<literal:redacted>");
		expect(redactApiKey("$OPENROUTER_API_KEY")).toBe("<env:OPENROUTER_API_KEY>");
		expect(redactApiKey("${DEEPSEEK_API_KEY}")).toBe("<env:DEEPSEEK_API_KEY>");
		expect(redactApiKey("!op read op://vault/item/key")).toBe("<command:redacted>");
		expect(redactApiKey("EMPTY")).toBe("<empty-placeholder>");
		expect(redactApiKey(undefined)).toBe("<missing>");
	});
});
