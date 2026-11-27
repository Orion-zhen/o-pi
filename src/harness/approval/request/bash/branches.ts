import type { SyntaxNode } from "../../../syntax-tree/types.ts";

export interface ResolvedShellValue {
	readonly value: string;
	readonly temporary: boolean;
	readonly elements?: readonly string[];
	/** 已知父目录时，value 用临时文件标记代表生成的路径。命令没有输出时该标记为空串。 */
	readonly fileDirectory?: string;
}

const CHOICE_LIMIT = 8;
export class IncompleteBashAnalysis extends Error {}
export type Directories = readonly ResolvedShellValue[];
export const UNKNOWN_DIRECTORY: ResolvedShellValue = { value: "\0unknown-directory", temporary: false };
export const UNSET = Symbol("unset");
export type KnownValue = ResolvedShellValue | typeof UNSET;
type Binding = KnownValue | { startup: KnownValue };
type Rows = readonly ReadonlyMap<string, Binding>[];
interface Column { readonly choices: readonly Binding[]; readonly rows: Rows }
type VariableValue = Binding | Column;

export interface BashAnalysisContext {
	readonly functionNames: ReadonlySet<string>;
	definitions: ReadonlyMap<string, readonly (SyntaxNode | undefined)[]>;
	locals?: ReadonlyMap<string, VariableValue | undefined>;
	plainBindings: boolean;
	bash: boolean;
	readonly simpleSites?: ReadonlySet<number> | undefined;
	usedEnvironment?: Map<string, string | null>;
	gitEnvKnown: boolean;
	cwd: Directories;
	variables: Map<string, VariableValue>;
	exitTrap: string | undefined;
}

export function cloneContext(context: BashAnalysisContext): BashAnalysisContext {
	return { ...context, variables: new Map(context.variables) };
}

function isColumn(value: VariableValue): value is Column {
	return value !== UNSET && "rows" in value;
}

function bindingValue(binding: Binding): KnownValue {
	return binding !== UNSET && "startup" in binding ? binding.startup : binding;
}

export function readVariable(name: string, context: BashAnalysisContext) {
	const binding = context.variables.get(name);
	const read = (entry: Binding): KnownValue => {
		if (entry === UNSET || !("startup" in entry)) return entry;
		context.usedEnvironment?.set(name, entry.startup === UNSET ? null : entry.startup.value);
		return entry.startup;
	};
	if (binding === undefined) return undefined;
	return isColumn(binding) ? { choices: binding.choices.map(read) } : read(binding);
}

function sameValue(a: ResolvedShellValue, b: ResolvedShellValue): boolean {
	if (a.value !== b.value || a.temporary !== b.temporary || a.fileDirectory !== b.fileDirectory) return false;
	const left = a.elements, right = b.elements;
	if (!left || !right) return left === right;
	return left.length === right.length && left.every((value, i) => value === right[i]);
}

function sameKnownValue(a: KnownValue, b: KnownValue): boolean {
	return a === b || a !== UNSET && b !== UNSET && sameValue(a, b);
}

function boundedChoices<T>(values: readonly T[], equal: (a: T, b: T) => boolean): T[] | undefined {
	const choices: T[] = [];
	for (const item of values) {
		if (choices.some(other => equal(other, item))) continue;
		if (choices.length === CHOICE_LIMIT) return undefined;
		choices.push(item);
	}
	return choices;
}

export function joinDirectories(values: Directories): Directories {
	return boundedChoices(values, sameValue) ?? [UNKNOWN_DIRECTORY];
}

function mergeBindings(values: VariableValue[]): Binding | Binding[] | undefined {
	const bindings = values.flatMap<Binding>(value => isColumn(value) ? value.choices : [value]);
	const startup = bindings.find(item => item !== UNSET && "startup" in item);
	const choices = boundedChoices(bindings.map(bindingValue), sameKnownValue);
	if (!choices) return undefined;
	// 相同值只占一个候选，任一分支依赖启动值时保留来源。
	const merged = choices.map(value => startup && sameKnownValue(value, startup.startup) ? startup : value);
	if (merged.length === 1) return merged[0];
	if (choices.some(item => item !== UNSET && item.fileDirectory !== undefined)) return undefined;
	return merged;
}

function column(name: string, choices: Binding[], rows: Rows = choices.map(value => new Map([[name, value]]))): Column {
	return { choices, rows };
}

type Paths = readonly [BashAnalysisContext, ...BashAnalysisContext[]];

function joinVariables(paths: Paths) {
	const [first, ...rest] = paths;
	const variables = new Map<string, VariableValue>();
	const related = new Map<string, Binding[]>();
	const rows: Map<string, Binding>[] = [];
	for (const [name, initial] of first.variables) {
		const values = rest.map(path => path.variables.get(name));
		if (!values.every(v => v !== undefined)) continue;
		if (values.every(v => v === initial)) { variables.set(name, initial); continue; }
		const inputs: VariableValue[] = [initial, ...values];
		const joined = mergeBindings(inputs);
		if (joined === undefined) continue;
		if (!Array.isArray(joined)) variables.set(name, joined);
		else if (paths.length <= CHOICE_LIMIT && inputs.every((v): v is Binding => !isColumn(v))) {
			related.set(name, joined);
			inputs.forEach((value, i) => (rows[i] ??= new Map<string, Binding>()).set(name, value));
		} else variables.set(name, column(name, joined));
	}
	// 单列只需枚举去重后的值。多列共享行，同行的值才能同时出现。
	for (const [name, choices] of related) variables.set(name, column(name, choices, related.size > 1 ? rows : undefined));
	return variables;
}

function joinContexts(paths: Paths): BashAnalysisContext {
	const [first] = paths;
	const locals = first.locals && new Map([...first.locals.keys()].map(key => {
		const saved = paths.map(c => c.locals?.get(key));
		const joined = saved.every(v => v !== undefined) ? mergeBindings(saved) : undefined;
		return [key, Array.isArray(joined) ? column(key, joined) : joined] as const;
	}));
	const names = new Set(paths.flatMap(c => [...c.definitions.keys()]));
	const definitions = new Map([...names].map(name => [name, [...new Set(paths.flatMap(c => c.definitions.get(name) ?? [undefined]))]] as const));
	return {
		...first, definitions, ...(locals && { locals }), variables: joinVariables(paths),
		plainBindings: paths.every(c => c.plainBindings), gitEnvKnown: paths.every(c => c.gitEnvKnown),
		cwd: joinDirectories(paths.flatMap(c => c.cwd)),
	};
}

// 不同 EXIT 动作在退出时读取各自路径上的变量和工作目录。
export function joinPaths(paths: BashAnalysisContext[]): BashAnalysisContext[] {
	if (paths.length <= 1) return paths;
	const groups = new Map<string | undefined, [BashAnalysisContext, ...BashAnalysisContext[]]>();
	for (const path of paths) {
		const group = groups.get(path.exitTrap);
		if (group) group.push(path);
		else groups.set(path.exitTrap, [path]);
	}
	if (groups.size > CHOICE_LIMIT) throw new IncompleteBashAnalysis();
	return Array.from(groups.values(), joinContexts);
}

/** 只展开当前单元读取的列。覆盖或删除绑定后，旧行不再包含该变量的当前值。 */
export function contextsForReads(context: BashAnalysisContext, names: Iterable<string>): BashAnalysisContext[] {
	let paths = [context];
	if (!context.variables.size && context.cwd.length === 1) return paths;
	const selected = new Set<string>();
	for (const name of names) {
		if (selected.has(name)) continue;
		if (name === "PWD" && context.cwd.length > 1) {
			selected.add(name);
			expand(context.cwd, (path, cwd) => { path.cwd = [cwd]; });
			continue;
		}
		const column = context.variables.get(name);
		if (column === undefined || !isColumn(column)) continue;
		expand(column.rows, (path, row) => {
			for (const [key, value] of row) {
				const active = context.variables.get(key);
				if (active !== undefined && isColumn(active) && active.rows === column.rows) {
					path.variables.set(key, value); selected.add(key);
				}
			}
		});
	}
	return paths;

	function expand<T>(choices: readonly T[], bind: (path: BashAnalysisContext, choice: T) => void) {
		if (paths.length * choices.length > CHOICE_LIMIT) throw new IncompleteBashAnalysis();
		paths = paths.flatMap(path => choices.map(choice => {
			const next = cloneContext(path); bind(next, choice); return next;
		}));
	}
}
