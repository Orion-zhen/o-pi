import type { WebSearchFailureDetails, WebSearchResult, WebSearchSuccessDetails } from "../core/types.ts";
import { escapeXml } from "../network/url-utils.ts";

export function webSearchResult(details: WebSearchResult["details"]): WebSearchResult {
	return { content: details.status === "success" ? successContent(details) : failureContent(details), details };
}

function successContent(details: WebSearchSuccessDetails): string {
	const body = details.results
		.map((item) => {
			const lines = [
				`[${item.rank}] ${escapeXml(item.title)}`,
				escapeXml(item.url),
				item.snippet ? escapeXml(item.snippet) : undefined,
			].filter((line): line is string => line !== undefined);
			return lines.join("\n");
		})
		.join("\n\n");
	return `<websearch>\n${body}\n</websearch>`;
}

function failureContent(details: WebSearchFailureDetails): string {
	return `<error tool="websearch" code="${escapeXml(details.error.code)}">
${escapeXml(details.error.message)}
</error>`;
}
