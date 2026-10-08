import { writeFileSync } from "node:fs";
import { StreamMessageReader } from "vscode-jsonrpc/node";

const mode = process.argv[2] ?? "normal";
const metadataPath = process.argv[3];
if (typeof metadataPath === "string") writeFileSync(metadataPath, `${process.pid}\n`);

if (mode === "stubborn") {
	process.on("SIGTERM", () => undefined);
	setInterval(() => undefined, 1000);
}

let initializeProcessId;

const reader = new StreamMessageReader(process.stdin);
reader.onError(() => process.exit(2));
reader.listen(handle);

function handle(message) {
	if (message.method === "initialize") {
		initializeProcessId = message.params?.processId;
		const respond = () => send({ id: message.id, result: { capabilities: {
			workspaceSymbolProvider: true,
			...(mode === "notification-timeout" ? { textDocumentSync: { openClose: true, change: 1 } } : {}),
		} } });
		if (mode.startsWith("stderr")) {
			process.stderr.write(`${"x".repeat(1024 * 1024)}\nSTDERR_TAIL_MARKER\n`, respond);
		} else {
			respond();
		}
		return;
	}
	if (message.method === "initialized") {
		if (typeof metadataPath === "string") writeFileSync(metadataPath, `${process.pid}\n${String(initializeProcessId)}`);
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
