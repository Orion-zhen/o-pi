import { session, MessageChannelMain, utilityProcess, type ForkOptions, type MessagePortMain, type UtilityProcess } from "electron";
import type { ProcessCommand, ServiceReply, ServiceRequest } from "./services-contract.ts";
import { serveWebSocket } from "./websocket-host.ts";

/** 主进程创建所有 SDK 工作进程，并为每个进程绑定独立的服务通道。 */
export function forkDesktopWorker(entry: string, args: string[], options: ForkOptions): UtilityProcess {
	const child = utilityProcess.fork(entry, args, { ...options, session: session.defaultSession });
	const { port1, port2 } = new MessageChannelMain();
	const resources = new Set<() => void>();
	let exited = false;
	const reply = (value: ServiceReply) => { if (!exited) port1.postMessage(value); };
	port1.on("message", ({ data }) => {
		const { id, request } = data as { id: number; request: ServiceRequest };
		if (request.kind === "proxy") {
			void session.defaultSession.resolveProxy(request.url).then(
				(value) => reply({ id, kind: "proxy", value }),
				(error: unknown) => reply({ id, kind: "error", message: String(error) }),
			);
			return;
		}
		const { port1: port, port2: channel } = new MessageChannelMain();
		port1.postMessage({ id, kind: "port" } satisfies ServiceReply, [channel]);
		try {
			const dispose = request.kind === "websocket"
				? serveWebSocket(port, request.url, request.options)
				: serveProcess(entry, port, request);
			resources.add(dispose);
			port.once("close", () => { resources.delete(dispose); dispose(); });
		} catch (error) {
			port.postMessage({ kind: "error", message: String(error) });
			port.close();
		}
	});
	port1.start();
	child.postMessage({ kind: "desktop-services" }, [port2]);
	child.once("exit", () => {
		exited = true;
		port1.close();
		for (const dispose of resources) dispose();
		resources.clear();
	});
	return child;
}

function serveProcess(entry: string, port: MessagePortMain, request: Extract<ServiceRequest, { kind: "spawn" }>): () => void {
	const env = { ...request.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = forkDesktopWorker(entry, request.args, {
		cwd: request.cwd, env, stdio: "pipe", serviceName: "opi-desktop subagent",
	});
	child.stdout?.on("data", (data: Buffer) => port.postMessage({ kind: "stdout", data }));
	child.stderr?.on("data", (data: Buffer) => port.postMessage({ kind: "stderr", data }));
	let exited = false;
	const kill = (signal: NodeJS.Signals) => {
		if (exited) return;
		if (signal === "SIGTERM") child.kill();
		else if (child.pid !== undefined) process.kill(child.pid, signal);
	};
	child.once("exit", (code) => {
		exited = true;
		port.postMessage({ kind: "exit", code });
		port.close();
	});
	port.on("message", ({ data }: { data: ProcessCommand }) => kill(data.signal));
	port.start();
	// 通道丢失后无人等待退出，直接清理孤立子进程。
	return () => kill("SIGKILL");
}
