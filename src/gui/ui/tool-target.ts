import { clean, record } from "./content.tsx";

export function toolTarget(name: string, args: unknown): string {
	if (!record(args)) return "";
	if (name === "subagent" && Array.isArray(args.tasks)) return args.tasks.filter(record)
		.flatMap((task) => typeof task.agent === "string" ? [task.agent] : []).join(" + ");
	const target = name === "bash" ? args.command : name === "grep" || name === "find" || name === "websearch"
		? args.query : name === "webfetch" ? args.url : args.path ?? args.name;
	return typeof target === "string" ? clean(target) : "";
}
