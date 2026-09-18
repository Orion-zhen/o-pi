import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function resolveShellEnvironment(home: string, inherited: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
	const shell = inherited.SHELL || userInfo().shell;
	if (!shell) throw new Error("Cannot determine login shell");
	const marker = randomUUID();
	const { stdout } = await execute(shell, ["-ilc", `printf '\\000%s\\000' '${marker}'; /usr/bin/env -0; printf '\\000%s\\000' '${marker}'`], {
		cwd: home,
		env: inherited,
		encoding: "utf8",
		timeout: 10_000,
		killSignal: "SIGKILL",
		maxBuffer: 1024 * 1024,
	});
	const boundary = `\0${marker}\0`;
	const start = stdout.indexOf(boundary);
	const end = stdout.indexOf(boundary, start + boundary.length);
	if (start < 0 || end < 0) throw new Error("Missing shell environment output");
	const environment: NodeJS.ProcessEnv = {};
	for (const entry of stdout.slice(start + boundary.length, end).split("\0")) {
		const separator = entry.indexOf("=");
		if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	if (!environment.PATH) throw new Error("Missing shell PATH");
	return { ...inherited, ...environment };
}
