export interface ModelReference {
	provider: string;
	id: string;
}

export function formatModelReference(model: ModelReference): string;
export function formatModelReference(model: undefined): undefined;
export function formatModelReference(model: ModelReference | undefined): string | undefined;
export function formatModelReference(model: ModelReference | undefined): string | undefined {
	return model === undefined ? undefined : `${model.provider}/${model.id}`;
}
