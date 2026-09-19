import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export function setModelScope(runtime: AgentSessionRuntime, ids: string[]): void {
	const available = new Map(
		runtime.services.modelRuntime.getAvailableSnapshot().map((model) => [`${model.provider}/${model.id}`, model]),
	);
	const previous = new Map(
		runtime.session.scopedModels.map((scoped) => [`${scoped.model.provider}/${scoped.model.id}`, scoped]),
	);
	const scope = ids.map((id) => {
		const model = available.get(id);
		if (!model) throw new Error(`模型不可用: ${id}`);
		return { ...previous.get(id), model };
	});
	runtime.session.setScopedModels(scope);
}

export function modelScope(runtime: AgentSessionRuntime): string[] {
	return runtime.session.scopedModels.map(({ model, thinkingLevel }) =>
		`${model.provider}/${model.id}${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}`);
}

export async function persistModelScope(runtime: AgentSessionRuntime): Promise<void> {
	const settings = runtime.services.settingsManager;
	settings.setEnabledModels(modelScope(runtime));
	await settings.flush();
	// SDK 把写入失败放入错误队列，flush 本身不会拒绝。
	const errors = settings.drainErrors();
	if (errors.length)
		throw new AggregateError(
			errors.map(({ error }) => error),
			"模型保存失败。",
		);
}
