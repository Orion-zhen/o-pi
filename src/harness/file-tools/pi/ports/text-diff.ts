import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { TextDiffGenerator } from "../../shared/text-diff.js";

export const piTextDiffGenerator: TextDiffGenerator = {
	generate(before, after) {
		const result = generateDiffString(before, after);
		return {
			diff: result.diff,
			...(result.firstChangedLine === undefined ? {} : { firstChangedLine: result.firstChangedLine }),
		};
	},
};
