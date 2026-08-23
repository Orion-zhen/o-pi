import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiKeyCredential, AuthResult } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createProviderAuth, resolveRefreshAuth, resolvedProviderHeaders } from "../../src/openai-compatible-provider/auth.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();
const activeSignal = new AbortController().signal;

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
		const configuredResult = await configured.resolve({ ctx, signal: activeSignal });
		if (!configuredResult) throw new Error("configured auth unexpectedly missing");
		expect(configuredResult).toMatchObject({
			auth: { apiKey: "sk-test", headers: { "X-Token": "header-token" } },
			source: "KEY",
		});
		expect(resolveRefreshAuth("gateway", credentialFromAuth(configuredResult))).toMatchObject({
			apiKey: "sk-test",
			headers: { "X-Token": "header-token" },
			keyless: false,
		});

		const keyless = createProviderAuth("local", {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
		});
		const keylessResult = await keyless.resolve({ ctx, signal: activeSignal });
		if (!keylessResult) throw new Error("keyless auth unexpectedly missing");
		expect(keylessResult).toMatchObject({
			auth: { apiKey: "unused", headers: { Authorization: null } },
			source: "keyless provider",
		});
		expect(resolveRefreshAuth("local", credentialFromAuth(keylessResult))).toMatchObject({ keyless: true });
		expect(resolveRefreshAuth("local", credentialFromAuth(keylessResult))).not.toHaveProperty("apiKey");
		expect(resolveRefreshAuth("local", { type: "api_key", key: "EMPTY" })).toMatchObject({
			apiKey: "EMPTY",
			keyless: false,
		});

		const providerHeadersEnv = Object.keys(configuredResult.env ?? {}).find((name) => name.includes("provider-headers"));
		if (!providerHeadersEnv) throw new Error("provider headers marker missing");
		expect(() => resolvedProviderHeaders("gateway", { [providerHeadersEnv]: "not-json" })).toThrow();

		const incomplete = createProviderAuth("incomplete", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "sk-test",
			headers: { "X-Account": "$MISSING_ACCOUNT" },
		});
		await expect(incomplete.check?.({ ctx, signal: activeSignal })).resolves.toBeUndefined();
		await expect(configured.resolve({ ctx, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
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

function credentialFromAuth(result: AuthResult): ApiKeyCredential {
	return {
		type: "api_key",
		...(result.auth.apiKey !== undefined ? { key: result.auth.apiKey } : {}),
		...(result.env !== undefined ? { env: result.env } : {}),
	};
}
