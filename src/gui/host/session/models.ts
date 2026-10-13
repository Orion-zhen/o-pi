import type { AgentSessionRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";

function scopePatterns(scope: AgentSessionRuntime["session"]["scopedModels"]): Map<string, string> {
	return new Map(scope.map(({ model, thinkingLevel }) => {
		const id = `${model.provider}/${model.id}`;
		return [id, `${id}${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}`];
	}));
}

type ResolvedScope = Awaited<ReturnType<typeof resolveModelScopeWithDiagnostics>>;

function scopeEntries(scope: ResolvedScope): Map<string, string> {
	const entries = scopePatterns(scope.scopedModels);
	for (const diagnostic of scope.diagnostics) {
		if (diagnostic.code === "no-match") entries.set(diagnostic.pattern, diagnostic.pattern);
	}
	return entries;
}

export class GuiModelScope {
	private selected = new Map<string, string>();
	private defaults: string[] = [];

	initialize(scope: ResolvedScope, defaults: ResolvedScope): void {
		this.defaults = [...scopeEntries(defaults).values()];
		this.selected = scopeEntries(scope);
	}

	get ids(): string[] { return [...this.selected.keys()]; }

	private entries(runtime: AgentSessionRuntime): Map<string, string> {
		const resolved = scopePatterns(runtime.session.scopedModels);
		return new Map([...this.selected].map(([id, pattern]) => [id, resolved.get(id) ?? pattern]));
	}

	patterns(runtime: AgentSessionRuntime): string[] {
		return [...this.entries(runtime).values()];
	}

	set(runtime: AgentSessionRuntime, ids: string[]): void {
		const available = new Map(
			runtime.services.modelRuntime.getAvailableSnapshot().map((model) => [`${model.provider}/${model.id}`, model]),
		);
		const previous = new Map(
			runtime.session.scopedModels.map((scoped) => [`${scoped.model.provider}/${scoped.model.id}`, scoped]),
		);
		const saved = this.entries(runtime);
		const scope = ids.flatMap((id) => {
			const model = available.get(id);
			if (!model) {
				if (!this.selected.has(id)) throw new Error(`模型不可用: ${id}`);
				return [];
			}
			return [{ ...previous.get(id), model }];
		});
		runtime.session.setScopedModels(scope);
		this.selected = new Map(ids.map((id) => [id, saved.get(id) ?? id]));
	}

	hasDefaultChanges(runtime: AgentSessionRuntime): boolean {
		const current = this.patterns(runtime);
		return current.length !== this.defaults.length || current.some((pattern, index) => pattern !== this.defaults[index]);
	}

	async persist(runtime: AgentSessionRuntime): Promise<void> {
		const patterns = this.patterns(runtime);
		runtime.services.settingsManager.setEnabledModels(patterns);
		await flushModelSettings(runtime);
		this.defaults = patterns;
	}
}

export async function persistDefaultModel(runtime: AgentSessionRuntime): Promise<void> {
	const { model, thinkingLevel } = runtime.session;
	if (!model) throw new Error("请先选择模型。");
	const settings = runtime.services.settingsManager;
	settings.setDefaultModelAndProvider(model.provider, model.id);
	settings.setDefaultThinkingLevel(thinkingLevel);
	await flushModelSettings(runtime);
}

async function flushModelSettings(runtime: AgentSessionRuntime): Promise<void> {
	const settings = runtime.services.settingsManager;
	await settings.flush();
	// SDK 把写入失败放入错误队列，flush 本身不会拒绝。
	const errors = settings.drainErrors();
	if (errors.length)
		throw new AggregateError(
			errors.map(({ error }) => error),
			"模型保存失败。",
		);
}
