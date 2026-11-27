import { isDeepStrictEqual } from "node:util";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import { assign, fork, merge, widenIteration, type Binding, type Flow, type Variable } from "./flow.ts";
import { CHOICE_LIMIT, IncompletePowerShellAnalysis } from "./locations.ts";

const transfers = ["exit", "error", "return", "break", "continue", "loopJump"] as const;
type Transfer = typeof transfers[number];
const routes = ["normal", ...transfers] as const;
type Route = typeof routes[number];
type Outcomes = Partial<Record<Route, Flow>>;
export type Evaluation<T> = Generator<readonly [Transfer, Flow], T, void>;
export type Execution = Evaluation<Flow | undefined>;

// flow 保留这条分支已经检查的副作用。只有 normal 出口能进入顺序块的下一句。
export interface Branch { flow: Flow; inLoop: boolean }

// 普通语句直接返回正常出口。只有处理跳转的结构才需要枚举并合并出口。
function* outcomes(run: Execution): Generator<readonly [Route, Flow]> {
	let step = run.next();
	while (!step.done) { yield step.value; step = run.next(); }
	if (step.value) yield ["normal", step.value];
}

function include(outcomes: Outcomes, route: Route, flow: Flow): void {
	const previous = outcomes[route];
	outcomes[route] = previous ? merge(previous, flow) : fork(flow);
}

export function* scoped(scope: "function" | "callback" | "current", parent: Flow, run: Execution): Execution {
	function leave(flow: Flow): Flow {
		if (scope === "current") return flow;
		const functions = new Map(parent.functions);
		for (const [key, bodies] of flow.functions) if (key.startsWith("script:")) functions.set(key, bodies);
		return { ...flow, functions, ...(scope === "function" && { locals: parent.locals, args: parent.args }) };
	}
	const ends: Outcomes = {};
	for (const [route, flow] of outcomes(run)) {
		if (route === "normal" || route === "return") include(ends, "normal", leave(flow));
		else yield [route, leave(flow)];
	}
	return ends.normal;
}

/** 回调可能执行零次或多次。只有本轮产生了新的入口状态，才需要再检查一轮。 */
export function* callbacks(parent: Flow, body: (branch: Branch) => Execution): Execution {
	function* repeat(): Execution {
		let entry = fork(parent);
		entry.independent = false;
		for (let i = 0; i < CHOICE_LIMIT; i++) {
			const next = yield* scoped("current", entry, body({ flow: fork(entry), inLoop: false }));
			if (!next) return entry;
			const joined = merge(entry, next);
			const again = i === 0 ? joined : widenIteration(entry, joined);
			if (isDeepStrictEqual(entry, again)) return joined;
			entry = again;
		}
		throw new IncompletePowerShellAnalysis();
	}
	return yield* scoped("callback", parent, repeat());
}

export function statementBlock(node: SyntaxNode): SyntaxNode {
	const block = node.namedChildren.find(n => n.type === "statement_block");
	if (!block) throw new Error(`Missing PowerShell statement_block in ${node.type}.`);
	return block;
}

/** catch 只接收异常。finally 检查每种可达状态，正常结束时保留进入它的原因。 */
export function* tryStatement(node: SyntaxNode, branch: Branch, visit: (block: SyntaxNode, branch: Branch) => Execution): Execution {
	function run(block: SyntaxNode, from: Flow): Outcomes {
		const child = { ...branch, flow: fork(from) }, result: Outcomes = {};
		for (const [route, flow] of outcomes(visit(block, child))) include(result, route, flow);
		branch.flow = child.flow;
		return result;
	}
	const tried = run(statementBlock(node), branch.flow);
	const error = tried.error;
	if (error) {
		const handlers = node.namedChildren.find(n => n.type === "catch_clauses")?.namedChildren.filter(n => n.type === "catch_clause") ?? [];
		if (handlers.length > CHOICE_LIMIT) throw new IncompletePowerShellAnalysis();
		if (handlers.some(h => !h.namedChildren.some(n => n.type === "catch_type_list"))) delete tried.error;
		for (const handler of handlers) {
			const caught = run(statementBlock(handler), error);
			for (const route of routes) if (caught[route]) include(tried, route, caught[route]);
		}
	}
	const final = node.namedChildren.find(n => n.type === "finally_clause");
	const result: Outcomes = final ? {} : tried;
	if (final) {
		const block = statementBlock(final);
		for (const route of routes) {
			const from = tried[route];
			if (!from) continue;
			const cleanup = run(block, from);
			if (cleanup.normal) include(result, route, cleanup.normal);
			for (const reason of transfers) if (cleanup[reason]) include(result, reason, cleanup[reason]);
		}
	}
	for (const route of transfers) if (result[route]) yield [route, result[route]];
	if (result.normal) branch.flow = result.normal;
	return result.normal;
}

export function* forEach(key: Variable, items: Binding[], branch: Branch, body: (iteration: Branch) => Execution): Execution {
	const ends: Outcomes = {};
	let next: Flow | undefined = branch.flow;
	for (const binding of items) {
		if (!next) break;
		yield ["error", next]; assign(next, key, binding);
		const iteration: Branch = { flow: next, inLoop: true }, jumps: Outcomes = {};
		for (const [route, flow] of outcomes(body(iteration))) {
			switch (route) {
				case "normal": case "break": case "continue": include(jumps, route, flow); break;
				case "loopJump": include(jumps, route, flow); yield [route, flow]; break;
				default: yield [route, flow];
			}
		}
		branch.flow = iteration.flow;
		// 未建模的跳转可能离开循环，也可能进入下一轮。
		if (jumps.loopJump) include(ends, "normal", jumps.loopJump);
		if (jumps.break) include(ends, "normal", jumps.break);
		if (jumps.normal?.uncertain) include(ends, "normal", jumps.normal);
		const ahead: Outcomes = {};
		for (const flow of [jumps.normal, jumps.loopJump, jumps.continue]) if (flow) include(ahead, "normal", flow);
		next = ahead.normal;
	}
	if (next) include(ends, "normal", next);
	if (ends.normal) branch.flow = ends.normal;
	return ends.normal;
}
