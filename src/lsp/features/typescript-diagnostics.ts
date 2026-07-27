import {
	DiagnosticSeverity,
	ExecuteCommandRequest,
	type Diagnostic,
	type DiagnosticRelatedInformation,
	type Position,
} from "vscode-languageserver-protocol";

import type { LspRequestOptions, LspServerCapabilities } from "../types.js";
import { pathToFileUri } from "../uri.js";
import type { LspFeatureSession } from "./index.js";

const TSLS_REQUEST_COMMAND = "typescript.tsserverRequest";
const TSLS_DIAGNOSTIC_COMMANDS = [
	"syntacticDiagnosticsSync",
	"semanticDiagnosticsSync",
	"suggestionDiagnosticsSync",
] as const;

export function typescriptDiagnosticsAvailable(capabilities: LspServerCapabilities | undefined): boolean {
	const provider: unknown = capabilities?.executeCommandProvider;
	if (!isRecord(provider) || !Array.isArray(provider["commands"])) return false;
	return provider["commands"].includes(TSLS_REQUEST_COMMAND);
}

/** 使用 TSLS 已声明的自定义命令获取带明确空结果的同步诊断。 */
export async function requestTypeScriptDiagnostics(
	session: LspFeatureSession,
	uri: string,
	options: LspRequestOptions,
): Promise<Diagnostic[] | undefined> {
	if (!typescriptDiagnosticsAvailable(session.capabilities())) return undefined;
	const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
	const diagnostics: Diagnostic[] = [];
	for (const command of TSLS_DIAGNOSTIC_COMMANDS) {
		const requestOptions = optionsBeforeDeadline(options, deadline);
		if (requestOptions === undefined) return undefined;
		const response: unknown = await session.request(ExecuteCommandRequest.type, {
			command: TSLS_REQUEST_COMMAND,
			arguments: [command, { file: uri }],
		}, requestOptions);
		const parsed = parseTypeScriptDiagnosticResponse(response);
		if (parsed === undefined) return undefined;
		diagnostics.push(...parsed);
	}
	return diagnostics;
}

function optionsBeforeDeadline(options: LspRequestOptions, deadline: number | undefined): LspRequestOptions | undefined {
	if (deadline === undefined) return options;
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return undefined;
	return { ...options, timeoutMs: remainingMs };
}

function parseTypeScriptDiagnosticResponse(value: unknown): Diagnostic[] | undefined {
	if (!isRecord(value) || value["success"] !== true) return undefined;
	const body = value["body"];
	if (body === undefined) return [];
	if (!Array.isArray(body)) return undefined;
	const diagnostics: Diagnostic[] = [];
	for (const item of body) {
		const diagnostic = parseTypeScriptDiagnostic(item);
		if (diagnostic === undefined) return undefined;
		diagnostics.push(diagnostic);
	}
	return diagnostics;
}

function parseTypeScriptDiagnostic(value: unknown): Diagnostic | undefined {
	if (!isRecord(value)) return undefined;
	const start = parseTypeScriptLocation(isRecord(value["start"]) ? value["start"] : value["startLocation"]);
	const end = parseTypeScriptLocation(isRecord(value["end"]) ? value["end"] : value["endLocation"]);
	const message = typeof value["text"] === "string" ? value["text"] : value["message"];
	if (start === undefined || end === undefined || typeof message !== "string" || positionAfter(start, end)) return undefined;
	const diagnostic: Diagnostic = {
		range: { start, end },
		message,
		severity: typeScriptDiagnosticSeverity(value["category"]),
		source: typeof value["source"] === "string" ? value["source"] : "typescript",
	};
	if (typeof value["code"] === "number" && Number.isInteger(value["code"])) diagnostic.code = value["code"];
	const relatedInformation = parseTypeScriptRelatedInformation(value["relatedInformation"]);
	if (relatedInformation.length > 0) diagnostic.relatedInformation = relatedInformation;
	return diagnostic;
}

function parseTypeScriptRelatedInformation(value: unknown): DiagnosticRelatedInformation[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item["message"] !== "string" || !isRecord(item["span"])) return [];
		const span = item["span"];
		const file = span["file"];
		const start = parseTypeScriptLocation(span["start"]);
		const end = parseTypeScriptLocation(span["end"]);
		if (typeof file !== "string" || start === undefined || end === undefined || positionAfter(start, end)) return [];
		return [{
			location: { uri: pathToFileUri(file), range: { start, end } },
			message: item["message"],
		}];
	});
}

function parseTypeScriptLocation(value: unknown): Position | undefined {
	if (!isRecord(value)) return undefined;
	const line = value["line"];
	const offset = value["offset"];
	if (!Number.isInteger(line) || !Number.isInteger(offset) || typeof line !== "number" || typeof offset !== "number" || line < 1 || offset < 1) {
		return undefined;
	}
	return { line: line - 1, character: offset - 1 };
}

function typeScriptDiagnosticSeverity(category: unknown): DiagnosticSeverity {
	if (category === "warning") return DiagnosticSeverity.Warning;
	if (category === "suggestion") return DiagnosticSeverity.Hint;
	return DiagnosticSeverity.Error;
}

function positionAfter(left: Position, right: Position): boolean {
	return left.line > right.line || (left.line === right.line && left.character > right.character);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
