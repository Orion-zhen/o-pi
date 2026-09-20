import type { WebFetchFailureDetails, WebFetchResult, WebFetchSuccessDetails } from "../core/types.ts";
import { escapeXml } from "../network/url-utils.ts";

export function successContent(details: WebFetchSuccessDetails, text: string): string {
	const partialReasons = [...new Set(details.omissions.map((item) => item.reason))];
	const attrs = [
		`kind="${details.page_kind}"`,
		details.pdf !== undefined ? `pages="${details.pdf.pages}/${details.pdf.total_pages}"` : undefined,
		details.pdf?.next_pages !== undefined ? `next_pages="${details.pdf.next_pages}"` : undefined,
		details.range.kind === "find" ? `matches="${details.range.matches}"` : undefined,
		details.anchor !== undefined ? `anchor="${escapeXml(details.anchor)}"` : undefined,
		details.final_url !== details.requested_url ? `final="${escapeXml(details.final_url)}"` : undefined,
		details.text_source === "metadata" ? `source="metadata"` : undefined,
		partialReasons.length > 0 ? `partial="${partialReasons.join(",")}"` : undefined,
		details.range.next_offset !== undefined ? `next="${details.range.next_offset}"` : undefined,
	].filter((item): item is string => item !== undefined).join(" ");
	return `<webfetch ${attrs}>\n${text}\n</webfetch>`;
}

export function failureResult(details: WebFetchFailureDetails): WebFetchResult {
	return { content: `<error tool="webfetch" code="${escapeXml(details.error.code)}">\n${escapeXml(details.error.message)}\n</error>`, details };
}

export function preview(text: string): string {
	return text.split("\n").slice(0, 40).join("\n").slice(0, 6000);
}
