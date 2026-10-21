import { parentPort } from "node:worker_threads";
import type { WorkerTaskRequest, WorkerTaskResponse } from "../../worker-runtime/worker-task-pool.ts";
import type { LineMatch, RegexRequest } from "./regex-matcher.ts";

if (parentPort === null) throw new Error("grep regex worker requires a parent port");
const port = parentPort;
port.on("message", ({ id, request }: WorkerTaskRequest<RegexRequest>) => {
	const regex = new RegExp(request.source, "u");
	const result = request.lines.map((line) => {
		const match = regex.exec(line);
		return match === null ? undefined : { start: match.index, end: match.index + match[0].length };
	});
	port.postMessage({ id, result } satisfies WorkerTaskResponse<Array<LineMatch | undefined>>);
});
