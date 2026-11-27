import path from "node:path";
import type { FunctionTable } from "./functions.ts";
import { CHOICE_LIMIT, IncompletePowerShellAnalysis, locations, type Location } from "./locations.ts";

export type Scalar = string | undefined;
export interface Binding { values: Scalar[]; type: "string" | "unknown"; guidPrefix?: string }
const startup = Symbol("startup");
type EnvValue = Scalar | typeof startup;

export interface Environment {
	values: ReadonlyMap<string, readonly [string, string | undefined]>;
	used: Map<string, string | null>;
}
export interface Flow {
	locals: Map<string, Binding>;
	env: Map<string, EnvValue[]>;
	args: readonly Scalar[][];
	functions: FunctionTable;
	positions: Location[];
	// bindings 包含 state：除了变量和位置，命令或类型成员的含义也可能改变。
	uncertain: false | "state" | "bindings";
	independent: boolean;
}

export function choices<T>(items: T[]): T[] {
	const unique = [...new Set(items)];
	if (unique.length > CHOICE_LIMIT) throw new IncompletePowerShellAnalysis();
	return unique;
}

export function initialFlow(cwd: string): Flow {
	return { locals: new Map(), env: new Map(), args: [], functions: new Map(), positions: [[cwd]], uncertain: false, independent: true };
}

// 延迟解析的输入不能保留即将释放的语法树节点。子进程只继承环境和当前位置。
export function fork(flow: Flow, scope: "branch" | "detached" | "process" = "branch"): Flow {
	const env = new Map(flow.env);
	if (scope === "process") return { ...flow, env, locals: new Map(), args: [], functions: new Map(),
		positions: locations(flow.positions.map(([cwd]) => [cwd])) };
	return { ...flow, env, locals: new Map(flow.locals), functions: scope === "branch" ? new Map(flow.functions) : new Map() };
}

function joinBindings<T>(maps: Map<string, T>[], join: (bindings: (T | undefined)[]) => T): Map<string, T> {
	const keys = new Set(maps.flatMap(map => [...map.keys()]));
	return new Map([...keys].map(key => {
		const bindings = maps.map(map => map.get(key)), first = bindings[0];
		return [key, first !== undefined && bindings.every(b => b === first) ? first : join(bindings)];
	}));
}

export function merge(first: Flow, ...rest: Flow[]): Flow {
	if (!rest.length) return first;
	const flows = [first, ...rest];
	return { functions: joinBindings(flows.map(f => f.functions), bindings => ({
		bodies: new Map(bindings.flatMap(b => b ? [...b.bodies] : [])),
		definite: bindings.every(b => b?.definite),
	})),
		locals: joinBindings(flows.map(f => f.locals), bs => ({ values: choices(bs.flatMap(b => b?.values ?? [undefined])), type: bs[0] && bs.every(b => b?.type === bs[0]?.type) ? bs[0].type : "unknown" })),
		env: joinBindings(flows.map(f => f.env), bs => choices(bs.flatMap(b => b ?? [startup]))),
		args: Array.from({ length: Math.max(...flows.map(f => f.args.length)) }, (_, i) => choices(flows.flatMap(f => f.args[i] ?? [undefined]))),
		positions: rest.every(f => f.positions === first.positions) ? first.positions : locations(flows.flatMap(f => f.positions)),
		independent: flows.every(f => f.independent),
		uncertain: flows.some(f => f.uncertain === "bindings") ? "bindings" : flows.some(f => f.uncertain) ? "state" : false };
}

/** 回调反复拼接字符串或切换相对目录时，只将继续增长的候选放宽为未知。 */
export function widenIteration(entry: Flow, joined: Flow): Flow {
	const result = fork(joined);
	function values<T extends EnvValue>(previous: T[] | undefined, all: T[]): (T | undefined)[] {
		return previous && all.length > previous.length ? choices([...previous, undefined]) : all;
	}
	for (const [name, binding] of joined.locals) {
		const widened = values(entry.locals.get(name)?.values, binding.values);
		if (widened !== binding.values) result.locals.set(name, { type: binding.type, values: widened });
	}
	for (const [name, all] of joined.env) result.env.set(name, values(entry.env.get(name), all));
	result.args = joined.args.map((all, i) => values(entry.args[i], all));
	if (joined.positions.length > entry.positions.length) result.positions = locations([...entry.positions, [undefined]]);
	return result;
}

export function invalidate(flow: Flow, effect: "state" | "bindings" = "state"): void {
	flow.independent = false;
	if (flow.uncertain !== "bindings") flow.uncertain = effect;
	flow.positions = locations([...flow.positions, [undefined]]);
}

// 自动变量、偏好设置和作用域限定名不按普通字符串绑定。
const managed = /^(?:ps.*|.*preference|args|input|matches|home|host|pid|pwd|true|false|null|error(?:view)?|formatenumerationlimit|maximum\w*count|outputencoding|foreach|switch|this|myinvocation|lastexitcode|stacktrace|executioncontext|shellid|profile|ofs|is(?:windows|linux|macos|coreclr)|_|enabledexperimentalfeatures|nestedpromptlevel|event.*|sender)$/iu;
export interface Variable { scope: "env" | "local"; name: string }
export function variable(text: string): Variable | undefined {
	const match = /^\$\{((?:env:)?[a-z_]\w*)\}$|^\$((?:env:)?[a-z_]\w*)$/iu.exec(text);
	const key = (match?.[1] ?? match?.[2])?.toLowerCase();
	if (!key || managed.test(key) || key === "env:psmodulepath") return;
	return key.startsWith("env:") ? { scope: "env", name: key.slice(4) } : { scope: "local", name: key };
}

export function variableType(text: string, flow: Flow): Binding["type"] {
	const key = variable(text);
	if (flow.uncertain || !key) return "unknown";
	return key.scope === "env" ? "string" : flow.locals.get(key.name)?.type ?? "unknown";
}

export function assign(flow: Flow, { scope, name }: Variable, binding: Binding): void {
	// 类型或只读属性未知时，赋值也可能保留旧值。
	if (scope === "local") {
		flow.locals.set(name, flow.uncertain ? { values: choices([...(flow.locals.get(name)?.values ?? [undefined]), ...binding.values]), type: "unknown" } : binding);
		return;
	}
	const previous = flow.uncertain ? flow.env.get(name) ?? [startup] : [];
	flow.env.set(name, choices<EnvValue>([...previous, ...binding.values, ...(binding.values.includes("") ? [undefined] : [])]));
}

export function lookup(text: string, flow: Flow, env: Environment, interpolate = false): Scalar[] {
	if (/^\$true$/iu.test(text)) return ["True"];
	if (/^\$false$/iu.test(text)) return ["False"];
	if (interpolate && /^\$(?:pwd|\{pwd\})$/iu.test(text)) return choices(flow.positions.map(([cwd]) => cwd && path.normalize(cwd)));
	const key = variable(text);
	if (!key) return [undefined];
	const values = key.scope === "local" ? flow.locals.get(key.name)?.values ?? [undefined]
		: (flow.env.get(key.name) ?? [startup]).map(value => {
			if (value !== startup) return value;
			const entry = env.values.get(key.name);
			env.used.set(entry?.[0] ?? key.name, entry?.[1] ?? null);
			return entry?.[1] ?? (interpolate ? "" : undefined);
		});
	return flow.uncertain ? choices([...values, undefined]) : choices(values);
}
