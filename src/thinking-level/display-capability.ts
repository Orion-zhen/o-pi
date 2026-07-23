import type { EventBus } from "@earendil-works/pi-coding-agent";

const QUERY_CHANNEL = "o-pi:thinking-display-query";
const RESET_CHANNEL = "o-pi:thinking-display-reset";

export type ThinkingDisplayCapability = "boolean";

export interface ThinkingDisplayModel {
	provider: string;
	id: string;
}

type ThinkingDisplayResolver = (model: ThinkingDisplayModel) => ThinkingDisplayCapability | undefined;

interface ThinkingDisplayQuery {
	model: ThinkingDisplayModel;
	respond(capability: ThinkingDisplayCapability): void;
}

/** 注册唯一的同步能力查询；新注册会移除同一 EventBus 上的旧 resolver。 */
export function registerThinkingDisplayResolver(events: EventBus, resolver: ThinkingDisplayResolver): () => void {
	clearThinkingDisplayResolver(events);
	let disposeQuery = () => {};
	let disposeReset = () => {};
	const dispose = () => {
		disposeQuery();
		disposeReset();
	};
	disposeQuery = events.on(QUERY_CHANNEL, (data) => {
		if (!isThinkingDisplayQuery(data)) return;
		const capability = resolver(data.model);
		if (capability !== undefined) data.respond(capability);
	});
	disposeReset = events.on(RESET_CHANNEL, dispose);
	return dispose;
}

export function clearThinkingDisplayResolver(events: EventBus): void {
	events.emit(RESET_CHANNEL, undefined);
}

/** 查询当前模型的展示能力；EventBus handler 必须在返回前同步响应。 */
export function queryThinkingDisplayCapability(
	events: EventBus,
	model: ThinkingDisplayModel,
): ThinkingDisplayCapability | undefined {
	let result: ThinkingDisplayCapability | undefined;
	events.emit(QUERY_CHANNEL, {
		model,
		respond(capability: ThinkingDisplayCapability) {
			result ??= capability;
		},
	} satisfies ThinkingDisplayQuery);
	return result;
}

function isThinkingDisplayQuery(value: unknown): value is ThinkingDisplayQuery {
	if (typeof value !== "object" || value === null) return false;
	const model: unknown = Reflect.get(value, "model");
	return isThinkingDisplayModel(model) && typeof Reflect.get(value, "respond") === "function";
}

function isThinkingDisplayModel(value: unknown): value is ThinkingDisplayModel {
	return typeof value === "object"
		&& value !== null
		&& typeof Reflect.get(value, "provider") === "string"
		&& typeof Reflect.get(value, "id") === "string";
}
