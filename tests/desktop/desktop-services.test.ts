import { utilityProcess } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import { forkDesktopWorker } from "../../src/desktop/worker-services.ts";
import type { ServiceCall, ServiceRequest } from "../../src/desktop/services-contract.ts";

const channels = vi.hoisted(() => [] as Electron.MessageChannelMain[]);

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	class Port extends EventEmitter {
		postMessage = vi.fn();
		start = vi.fn();
		close = vi.fn();
	}
	return {
		MessageChannelMain: class {
			port1 = new Port();
			port2 = new Port();
			constructor() { channels.push(this); }
		},
		utilityProcess: { fork: vi.fn(() => Object.assign(new EventEmitter(), { postMessage: vi.fn() })) },
		net: { WebSocket: class { constructor() { throw new Error("socket creation failed"); } } },
		session: { defaultSession: {} },
	};
});

beforeEach(() => { vi.clearAllMocks(); channels.length = 0; });

it.each(["websocket", "spawn"] as const)("%s 创建失败返回请求错误，不交付失效端口并释放通道", (kind) => {
	const child = forkDesktopWorker("backend.mjs", [], { stdio: "pipe" });
	const root = channels[0];
	if (!root) throw new Error("缺少宿主通道");
	if (kind === "spawn") vi.mocked(utilityProcess.fork).mockImplementationOnce(() => { throw new Error("spawn creation failed"); });
	const request: ServiceRequest = kind === "websocket"
		? { kind, url: "ws://example.test", options: {} } : { kind, args: [], cwd: "/work", env: {} };
	root.port1.emit("message", { data: { id: 7, request } satisfies ServiceCall });
	expect(root.port1.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 7, kind: "error", message: expect.stringContaining("creation failed") });
	const service = channels[1];
	if (!service) throw new Error("缺少服务通道");
	expect(service.port1.postMessage).not.toHaveBeenCalled();
	expect(service.port1.close).toHaveBeenCalled();
	expect(service.port2.close).toHaveBeenCalled();
	child.emit("exit", 0);
});
