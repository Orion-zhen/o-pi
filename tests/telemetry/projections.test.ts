import { describe, expect, it } from "vitest";

import { bashTelemetry } from "../../src/bash-tool/telemetry.js";
import type { BashParams, BashToolDetails } from "../../src/bash-tool/types.js";
import { editTelemetry } from "../../src/file-tools/telemetry/edit.js";
import { findTelemetry } from "../../src/file-tools/telemetry/find.js";
import { grepTelemetry } from "../../src/file-tools/telemetry/grep.js";
import { readTelemetry } from "../../src/file-tools/telemetry/read.js";
import { writeTelemetry } from "../../src/file-tools/telemetry/write.js";
import type { EditParams, EditSuccess, FindDetails, FindParams, GrepParams, GrepSuccess, ReadFileSuccess, ReadParams, ToolOutcome, WriteParams, WriteSuccess } from "../../src/file-tools/types.js";
import { safeProject } from "../../src/telemetry/projection.js";
import type { TelemetryFacts, ToolTelemetry } from "../../src/telemetry/types.js";
import { webFetchTelemetry } from "../../src/web-tools/telemetry/webfetch.js";
import { webSearchTelemetry } from "../../src/web-tools/telemetry/websearch.js";
import type { WebFetchDetails, WebFetchParams, WebSearchDetails, WebSearchParams } from "../../src/web-tools/types.js";

describe("tool telemetry projections", () => {
	it("bounds invalid and oversized facts without throwing", () => {
		const projected = safeProject(() => ({
			fields: { body: "x".repeat(1_000), invalid: { nested: true } },
			targets: Array.from({ length: 70 }, (_, index) => ({ kind: "file", value: `src/${index}.ts` })),
			candidates: [{ kind: "file", value: "src/a.ts", rank: 1, sources: ["repo-map"] }],
		}));
		expect(projected.error).toBe("invalid_projection");
		expect(projected.limited).toBe(true);
		expect(projected.facts.fields).toMatchObject({ body_chars: 1_000 });
		expect(projected.facts.fields).not.toHaveProperty("body");
		expect(projected.facts.targets).toHaveLength(64);
	});

	it("edit records decision metrics and path but no replacement bodies", () => {
		const params: EditParams = { path: "src/a.ts", edits: [{ old: "secret old", new: "secret new" }, { old: "x", new: "y" }] };
		const input = inputFacts(editTelemetry, params);
		const output = resultFacts(editTelemetry, params, fixture<ToolOutcome<EditSuccess>>({
			status: "applied", path: "src/a.ts", replacements: 2, old_version: "old", new_version: "new", old_size_bytes: 10, new_size_bytes: 20, diff: "secret diff",
		}));
		expect(input).toMatchObject({ fields: { input_edit_count: 2, input_old_chars: 11, input_new_chars: 11 }, targets: [{ kind: "file", value: "src/a.ts" }] });
		expect(output.fields).toMatchObject({ status: "applied", replacement_count: 2, changed: true });
		expectNoBody(input, output);
	});

	it("find and grep preserve displayed candidate order and ranking sources", () => {
		const findParams = fixture<FindParams>({ path: ".", query: "private symbol", glob: "*.ts" });
		const findInput = inputFacts(findTelemetry, findParams);
		const findOutput = resultFacts(findTelemetry, findParams, fixture<FindDetails>({
			status: "ok",
			displayedMatches: [{ path: "src/a.ts" }],
			candidateSources: { "src/a.ts": ["lexical", "repo-map"] },
			related: [{ path: "src/b.ts" }],
		}));
		expect(findInput.fields).toMatchObject({ input_query_chars: 14, input_glob_chars: 4 });
		expect(JSON.stringify(findInput)).not.toContain("private symbol");
		expect(findOutput.candidates).toEqual([
			{ kind: "path", value: "src/a.ts", rank: 1, group: "primary", sources: ["lexical", "repo-map"] },
			{ kind: "path", value: "src/b.ts", rank: 2, group: "related", sources: ["repo-map"] },
		]);

		const grepParams = fixture<GrepParams>({ path: "src", query: "needle" });
		const grepOutput = resultFacts(grepTelemetry, grepParams, fixture<ToolOutcome<GrepSuccess>>({
			status: "ok",
			regions: [
				{ path: "src/c.ts", start_line: 2, end_line: 4, sources: ["repo-map-direct"] },
				{ path: "src/d.ts", start_line: 6, end_line: 8, sources: ["lsp-workspace-symbol", "lsp-reference"] },
			],
		}));
		expect(grepOutput.candidates).toEqual([
			{ kind: "region", value: "src/c.ts", rank: 1, group: "primary", start_line: 2, end_line: 4, sources: ["repo-map-direct"] },
			{ kind: "region", value: "src/d.ts", rank: 2, group: "primary", start_line: 6, end_line: 8, sources: ["lsp-reference", "lsp-workspace-symbol"] },
		]);
	});

	it("read and write expose targets while hashing content", () => {
		const readParams = fixture<ReadParams>({ path: "src/a.ts", start_line: 2, end_line: 5 });
		expect(inputFacts(readTelemetry, readParams).targets).toEqual([{ kind: "region", value: "src/a.ts", start_line: 2, end_line: 5 }]);
		const readResult = resultFacts(readTelemetry, readParams, fixture<ToolOutcome<ReadFileSuccess>>({ status: "ok", path: "src/a.ts", content: "private body" }));
		expectNoBody(readResult);

		const writeParams = fixture<WriteParams>({ path: "src/new.ts", content: "private content" });
		const writeInput = inputFacts(writeTelemetry, writeParams);
		expect(writeInput.fields).toMatchObject({ input_content_chars: 15, input_content_lines: 1 });
		expect(writeInput.targets).toEqual([{ kind: "file", value: "src/new.ts" }]);
		expect(JSON.stringify(writeInput)).not.toContain("private content");
		resultFacts(writeTelemetry, writeParams, fixture<ToolOutcome<WriteSuccess>>({ status: "written", path: "src/new.ts" }));
	});

	it("web search links ranked URLs to later fetch targets without storing the query", () => {
		const searchParams = fixture<WebSearchParams>({ query: "private query", limit: 5 });
		const input = inputFacts(webSearchTelemetry, searchParams);
		const output = resultFacts(webSearchTelemetry, searchParams, fixture<WebSearchDetails>({
			status: "ok", provider: "brave_api", primary_provider: "brave_api", query_type: "general", formal_provider_calls: 2, first_call_accepted: false, fallback_reason: "too_few_results", secondary_new_results: 2,
			results: [{ title: "A", url: "https://example.com/a", rank: 3, provenance: [{ provider: "brave_api", rank: 1 }, { provider: "tavily", rank: 2 }] }],
		}));
		expect(input.fields).toMatchObject({ input_query_chars: 13, input_limit: 5 });
		expect(JSON.stringify(input)).not.toContain("private query");
		expect(output.fields).toMatchObject({ primary_provider: "brave_api", query_type: "general", formal_provider_calls: 2, first_call_accepted: false, fallback_reason: "too_few_results", secondary_new_results: 2 });
		expect(output.candidates).toEqual([{ kind: "url", value: "https://example.com/a", rank: 1, group: "primary", sources: ["brave_api", "tavily"] }]);

		const fetchParams = fixture<WebFetchParams>({ url: "https://example.com/a" });
		expect(inputFacts(webFetchTelemetry, fetchParams).targets).toEqual([{ kind: "url", value: "https://example.com/a" }]);
		resultFacts(webFetchTelemetry, fetchParams, fixture<WebFetchDetails>({ status: "ok", final_url: "https://example.com/a" }));
	});

	it("bash stores command shape and outcome, not command output", () => {
		const params = fixture<BashParams>({ command: "printf secret", timeout: 10 });
		const input = inputFacts(bashTelemetry, params);
		const output = resultFacts(bashTelemetry, params, fixture<BashToolDetails>({
			status: "completed", exit_code: 0, output_state: "complete", output_format: "text", capture_complete: true,
			total_lines: 1, returned_lines: 1, total_bytes: 6, returned_bytes: 6, output: "secret",
		}));
		expect(input.fields).toMatchObject({ input_command_chars: 13, input_timeout_seconds: 10 });
		expect(output.fields).toMatchObject({ status: "completed", exit_code: 0 });
		expectNoBody(input, output);
	});
});

function inputFacts<TParams, TDetails>(telemetry: ToolTelemetry<TParams, TDetails>, params: TParams): TelemetryFacts {
	return telemetry.input?.(params) ?? {};
}

function resultFacts<TParams, TDetails>(telemetry: ToolTelemetry<TParams, TDetails>, params: TParams, details: TDetails): TelemetryFacts {
	return telemetry.result?.(params, { details }) ?? {};
}

function expectNoBody(...facts: readonly TelemetryFacts[]): void {
	const serialized = JSON.stringify(facts);
	for (const text of ["secret old", "secret new", "secret diff", "private body", "printf secret", '"output":"secret"']) {
		expect(serialized).not.toContain(text);
	}
}

function fixture<T>(value: unknown): T {
	return value as T;
}
