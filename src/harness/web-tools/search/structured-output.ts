import { Type, type Static } from "typebox";
import type { WebSearchSuccessDetails } from "../core/types.ts";

export const webSearchOutputSchema = Type.Object({
	results: Type.Array(Type.Object({
		title: Type.String(), url: Type.String(), snippet: Type.Optional(Type.String()),
	})),
});

/** 提供方诊断和合并来源不进入脚本结果。 */
export function webSearchStructuredOutput(details: WebSearchSuccessDetails): Static<typeof webSearchOutputSchema> {
	return { results: details.results.map(({ title, url, snippet }) => ({
		title, url, ...(snippet === undefined ? {} : { snippet }),
	})) };
}
