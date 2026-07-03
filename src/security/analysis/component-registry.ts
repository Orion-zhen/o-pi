import type { ComponentAnalyzer, ComponentIdentity, ComponentKind } from "../model/types.js";
import { digest } from "../model/digest.js";

export interface ComponentRegistration {
	identity: ComponentIdentity;
	analyzer: ComponentAnalyzer;
}

export interface ComponentCatalogEntry {
	identity: ComponentIdentity;
	conflict: boolean;
	active: boolean;
}

/** 组件 registry 以稳定 identity 为主键；显示名称冲突时不自动选择实现。 */
export class ComponentRegistry {
	private readonly registrations = new Map<string, ComponentRegistration>();
	private readonly activeBindings = new Map<string, string>();
	private generation = 0;

	register(registration: ComponentRegistration): void {
		this.registrations.set(registration.identity.id, registration);
		const key = bindingKey(registration.identity);
		const candidates = this.candidates(key);
		if (candidates.length === 1) this.activeBindings.set(key, registration.identity.id);
		if (candidates.length > 1) this.activeBindings.delete(key);
		this.generation += 1;
	}

	resolve(kind: ComponentKind, displayName: string): ComponentRegistration | undefined {
		const id = this.activeBindings.get(`${kind}:${displayName}`);
		return id === undefined ? undefined : this.registrations.get(id);
	}

	get(id: string): ComponentRegistration | undefined {
		return this.registrations.get(id);
	}

	catalog(): ComponentCatalogEntry[] {
		return [...this.registrations.values()]
			.map((registration) => {
				const key = bindingKey(registration.identity);
				const candidates = this.candidates(key);
				return {
					identity: registration.identity,
					conflict: candidates.length > 1,
					active: this.activeBindings.get(key) === registration.identity.id,
				};
			})
			.sort((left, right) => `${left.identity.kind}:${left.identity.displayName}`.localeCompare(`${right.identity.kind}:${right.identity.displayName}`));
	}

	registryDigest(): string {
		return digest({
			generation: this.generation,
			components: this.catalog().map((entry) => ({
				identity: entry.identity,
				conflict: entry.conflict,
				active: entry.active,
			})),
		});
	}

	private candidates(key: string): ComponentRegistration[] {
		return [...this.registrations.values()].filter((candidate) => bindingKey(candidate.identity) === key);
	}
}

export function componentIdentity(input: {
	kind: ComponentKind;
	displayName: string;
	sourceDigest: string;
	schemaDigest?: string;
	manifestDigest?: string;
}): ComponentIdentity {
	const base: Omit<ComponentIdentity, "id"> = {
		kind: input.kind,
		displayName: input.displayName,
		sourceDigest: input.sourceDigest,
		...(input.schemaDigest !== undefined ? { schemaDigest: input.schemaDigest } : {}),
		...(input.manifestDigest !== undefined ? { manifestDigest: input.manifestDigest } : {}),
	};
	return {
		id: `${input.kind}:${input.displayName}@${digest(base)}`,
		...base,
	};
}

function bindingKey(identity: ComponentIdentity): string {
	return `${identity.kind}:${identity.displayName}`;
}
