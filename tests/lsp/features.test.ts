import type { RequestType } from "vscode-jsonrpc/node";
import { SymbolKind, type ServerCapabilities } from "vscode-languageserver-protocol";
import { describe, expect, it } from "vitest";

import {
	requestIncomingCalls,
	requestReferences,
	type LspFeatureSession,
} from "../../src/lsp/features/index.js";

describe("lsp semantic feature adapters", () => {
	it("按 capability 请求 references 与 incoming call hierarchy", async () => {
		const session = new FeatureSessionFixture(
			{ referencesProvider: true, callHierarchyProvider: true },
			new Map<string, unknown>([
				["textDocument/references", [{ uri: "file:///workspace/use.ts", range: range() }]],
				["textDocument/prepareCallHierarchy", [{
					name: "Target",
					kind: SymbolKind.Function,
					uri: "file:///workspace/target.ts",
					range: range(),
					selectionRange: range(),
				}]],
				["callHierarchy/incomingCalls", [{
					from: {
						name: "caller",
						kind: SymbolKind.Function,
						uri: "file:///workspace/use.ts",
						range: range(),
						selectionRange: range(),
					},
					fromRanges: [],
				}]],
			]),
		);

		await expect(requestReferences(session, "file:///workspace/target.ts", { line: 0, character: 16 }))
			.resolves.toEqual([{ uri: "file:///workspace/use.ts", range: range() }]);
		await expect(requestIncomingCalls(session, "file:///workspace/target.ts", { line: 0, character: 16 }))
			.resolves.toEqual([expect.objectContaining({ from: expect.objectContaining({ name: "caller" }) })]);
		expect(session.methods).toEqual([
			"textDocument/references",
			"textDocument/prepareCallHierarchy",
			"callHierarchy/incomingCalls",
		]);
	});

	it("capability 缺失时不发送请求", async () => {
		const session = new FeatureSessionFixture({}, new Map());

		await expect(requestReferences(session, "file:///workspace/target.ts", { line: 0, character: 0 }))
			.resolves.toBeUndefined();
		await expect(requestIncomingCalls(session, "file:///workspace/target.ts", { line: 0, character: 0 }))
			.resolves.toBeUndefined();
		expect(session.methods).toEqual([]);
	});
});

class FeatureSessionFixture implements LspFeatureSession {
	readonly methods: string[] = [];

	constructor(
		private readonly serverCapabilities: ServerCapabilities,
		private readonly responses: ReadonlyMap<string, unknown>,
	) {}

	capabilities(): ServerCapabilities {
		return this.serverCapabilities;
	}

	async request<P, R, E>(type: RequestType<P, R, E>): Promise<R | undefined> {
		this.methods.push(type.method);
		return this.responses.get(type.method) as R | undefined;
	}
}

function range() {
	return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}
