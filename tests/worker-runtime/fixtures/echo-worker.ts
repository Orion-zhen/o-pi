import { parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("worker parent port is unavailable");
const port = parentPort;
port.on("message", (value: unknown) => {
	if (typeof value !== "number") throw new Error("expected a number");
	port.postMessage(value * 2);
});
