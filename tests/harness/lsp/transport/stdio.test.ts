import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stdioClient, useTransportFixture } from "./fixtures.js";

const transport = useTransportFixture();

describe("lsp transport stdio", () => {
	it("stdio drain 大量 stderr并保留有界尾部", async () => {
		const client = stdioClient(transport, "stderr-crash");
		expect(await client.ensureReady()).toBe(true);
		await expect(client.workspaceSymbols("crash")).resolves.toBeUndefined();
		const status = client.status();
		expect(status).toMatchObject({
			status: "crashed",
			open_documents: 0,
			last_error: expect.stringContaining("STDERR_TAIL_MARKER"),
		});
		expect(status.last_error).not.toContain("\n");
		expect(status.last_error?.length).toBeLessThanOrEqual(1024);
		await client.shutdown();
	});
	it("文档同步 backpressure 超时后进入 crash cleanup", async () => {
		const workspace = transport.workspace;
		const client = stdioClient(transport, "notification-timeout");
		expect(await client.ensureReady()).toBe(true);
		await expect(client.documentSymbols(path.join(workspace, "large.ts"), "x".repeat(16 * 1024 * 1024))).resolves.toBeUndefined();
		expect(client.status()).toMatchObject({ status: "crashed", open_documents: 0 });
	});
	it("shutdown 在 writer backpressure 下不会泄漏未处理的 stream rejection", async () => {
		const workspace = transport.workspace;
		const client = stdioClient(transport, "notification-timeout");
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			expect(await client.ensureReady()).toBe(true);
			const blocked = client.documentSymbols(path.join(workspace, "large.ts"), "x".repeat(16 * 1024 * 1024));
			await new Promise<void>((resolve) => setImmediate(resolve));
			await Promise.allSettled([blocked, client.shutdown()]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
	it("stdio 顽固 child 在 shutdown 后被强制终止", async () => {
		const configDir = transport.configDir;
		const client = stdioClient(transport, "stubborn");
		expect(await client.ensureReady()).toBe(true);
		const metadata = (await readFile(path.join(configDir, "stdio-stubborn.meta"), "utf8")).trim().split("\n");
		const pid = Number(metadata[0]);
		expect(Number.isInteger(pid)).toBe(true);
		await client.shutdown();
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
