import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AgentProcess, HostServices } from "../harness/runtime/host-services.ts";
import type { ProcessEvent, ServiceReply, ServiceRequest } from "./services-contract.ts";

export type OpenService = (request: Exclude<ServiceRequest, { kind: "proxy" }>) => Promise<Electron.MessagePortMain>;

export function openServiceChannel(port: Electron.MessagePortMain): { open: OpenService; host: HostServices } {
	let nextId = 0;
	let closed = false;
	const pending = new Map<number, { resolve: (value: string | Electron.MessagePortMain) => void; reject: (error: unknown) => void }>();
	port.on("message", ({ data, ports }: Electron.MessageEvent) => {
		const reply = data as ServiceReply;
		const operation = pending.get(reply.id);
		if (reply.kind === "error") operation?.reject(new Error(reply.message));
		else if (reply.kind === "proxy") operation?.resolve(reply.value);
		else if (ports[0]) operation?.resolve(ports[0]);
		else operation?.reject(new Error("Desktop service port missing"));
	});
	port.once("close", () => {
		closed = true;
		for (const task of pending.values()) task.reject(new Error("Desktop services closed"));
		pending.clear();
	});
	port.start();
	async function requestService(request: ServiceRequest, signal?: AbortSignal): Promise<string | Electron.MessagePortMain> {
		signal?.throwIfAborted();
		if (closed) throw new Error("Desktop services closed");
		const id = nextId++;
		const abort = () => pending.get(id)?.reject(signal?.reason);
		try {
			return await new Promise<string | Electron.MessagePortMain>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				signal?.addEventListener("abort", abort, { once: true });
				port.postMessage({ id, request });
			});
		} finally {
			pending.delete(id);
			signal?.removeEventListener("abort", abort);
		}
	}
	const open: OpenService = async (request) => {
		const value = await requestService(request);
		if (typeof value === "string") throw new Error("Desktop service port expected");
		return value;
	};
	return { open, host: {
		spawnAgent: (args, cwd, env) => new RemoteProcess(open({ kind: "spawn", args, cwd, env })),
		async resolveProxy(url, signal) {
			const value = await requestService({ kind: "proxy", url }, signal);
			if (typeof value !== "string") throw new Error("Desktop proxy result expected");
			return value;
		},
	} };
}

class RemoteProcess extends EventEmitter implements AgentProcess {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	constructor(private readonly port: Promise<Electron.MessagePortMain>) {
		super();
		void port.then((channel) => {
			channel.on("message", ({ data }: Electron.MessageEvent) => {
				const event = data as ProcessEvent;
				if (event.kind === "stdout" || event.kind === "stderr") this[event.kind].write(event.data);
				else if (event.kind === "error") { this.emit("error", new Error(event.message)); this.finish(1); }
				else if (event.kind === "exit") this.finish(event.code);
			});
			channel.once("close", () => {
				if (this.exitCode === null) {
					this.emit("error", new Error("Desktop child process service closed"));
					this.finish(1);
				}
			});
			channel.start();
		}, (error: unknown) => { this.emit("error", error); this.finish(1); });
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.exitCode !== null) return false;
		void this.port.then((port) => port.postMessage({ kind: "kill", signal }), () => {});
		return true;
	}
	private finish(code: number): void {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code);
		void this.port.then((port) => port.close(), () => {});
	}
}
