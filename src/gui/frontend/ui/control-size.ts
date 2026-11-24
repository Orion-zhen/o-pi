export const controlSize = {
	default: "px-[0.9em] py-[0.6em]",
	sm: "px-[0.75em] py-[0.45em] text-[length:var(--text-small)]",
	lg: "px-[1.25em] py-[0.75em]",
} as const;

export const fieldSize = { default: controlSize.default, compact: controlSize.sm } as const;
export type FieldDensity = keyof typeof fieldSize;
