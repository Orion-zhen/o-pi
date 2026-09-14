export interface TextDiff {
	readonly diff: string;
	readonly firstChangedLine?: number;
}

/** Host-provided diff renderer; commands remain independent of Pi. */
export interface TextDiffGenerator {
	generate(before: string, after: string): TextDiff | Promise<TextDiff>;
}
