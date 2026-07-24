// @ts-nocheck -- standalone child-process fixture executed outside the Vitest TypeScript runtime.
const mode = process.argv[2] ?? "normal";

if (mode === "stubborn") {
	process.on("SIGTERM", () => undefined);
	setInterval(() => undefined, 1000);
}

let buffer = Buffer.alloc(0);
let initializeProcessId;

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const marker = buffer.indexOf("\r\n\r\n");
		if (marker < 0) return;
		const header = buffer.subarray(0, marker).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (match === null) process.exit(2);
		const length = Number(match[1]);
		const start = marker + 4;
		if (buffer.length < start + length) return;
		const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
		buffer = buffer.subarray(start + length);
		handle(message);
	}
});

function handle(message) {
	if (message.method === "initialize") {
		initializeProcessId = message.params?.processId;
		const respond = () => send({ id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
		if (mode.startsWith("stderr")) {
			process.stderr.write(`${"x".repeat(1024 * 1024)}\nSTDERR_TAIL_MARKER\n`, respond);
		} else {
			respond();
		}
		return;
	}
	if (message.method === "initialized") {
		send({ method: "window/logMessage", params: { type: 3, message: `pid:${process.pid};parent:${String(initializeProcessId)}` } });
		if (mode === "notification-timeout") process.stdin.pause();
		return;
	}
	if (message.method === "workspace/symbol") {
		if (mode === "stderr-crash") process.exit(3);
		send({ id: message.id, result: [] });
		return;
	}
	if (message.method === "shutdown") {
		send({ id: message.id, result: null });
		return;
	}
	if (message.method === "exit" && mode !== "stubborn") process.exit(0);
}

function send(message) {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
