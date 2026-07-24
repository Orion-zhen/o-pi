import path from "node:path";
import picomatch from "picomatch";

import type { LspLanguageRoute, LspServerConfig } from "./types.js";
import { workspaceRelativePath } from "./uri.js";

interface CompiledLanguageRoute {
	languageId: string;
	matches(relativePath: string): boolean;
}

const compiledServers = new WeakMap<LspServerConfig, readonly CompiledLanguageRoute[]>();

export class LspRoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspRoutingError";
	}
}

export function matchServerLanguage(server: LspServerConfig, relativePath: string): string | undefined {
	const normalizedPath = normalizeRelativePath(relativePath);
	let matchedLanguage: string | undefined;
	for (const route of compiledRoutes(server)) {
		if (!route.matches(normalizedPath)) continue;
		if (matchedLanguage !== undefined && matchedLanguage !== route.languageId) {
			throw new LspRoutingError(
				`LSP server "${server.id}" routes "${normalizedPath}" to both "${matchedLanguage}" and "${route.languageId}"`,
			);
		}
		matchedLanguage = route.languageId;
	}
	return matchedLanguage;
}

export function languageIdForServerPath(server: LspServerConfig, workspaceRoot: string, filePath: string): string {
	const relativePath = workspaceRelativePath(workspaceRoot, filePath);
	if (relativePath === undefined) throw new LspRoutingError(`LSP file is outside workspace "${workspaceRoot}": ${filePath}`);
	const languageId = matchServerLanguage(server, relativePath);
	if (languageId === undefined) throw new LspRoutingError(`LSP server "${server.id}" does not route "${relativePath}"`);
	return languageId;
}

export function validateServerRoutes(server: LspServerConfig): void {
	compiledRoutes(server);
}

function compiledRoutes(server: LspServerConfig): readonly CompiledLanguageRoute[] {
	const cached = compiledServers.get(server);
	if (cached !== undefined) return cached;
	const compiled = server.routes.map((route) => compileLanguageRoute(server.id, route));
	compiledServers.set(server, compiled);
	return compiled;
}

function compileLanguageRoute(serverId: string, route: LspLanguageRoute): CompiledLanguageRoute {
	const matchers = route.selectors.map((selector) => compileSelector(serverId, route.languageId, selector));
	return {
		languageId: route.languageId,
		matches: (relativePath) => matchers.some((matcher) => matcher(relativePath)),
	};
}

function compileSelector(serverId: string, languageId: string, selector: string): (relativePath: string) => boolean {
	validateSelector(serverId, languageId, selector);
	try {
		const matcher = picomatch(selector, {
			dot: true,
			nocase: false,
			noext: true,
			nonegate: true,
			strictBrackets: true,
		});
		const basenameOnly = !selector.includes("/");
		return (relativePath) => matcher(basenameOnly ? path.posix.basename(relativePath) : relativePath);
	} catch (error) {
		throw new LspRoutingError(
			`LSP server "${serverId}" has invalid selector ${JSON.stringify(selector)} for "${languageId}": ${errorMessage(error)}`,
		);
	}
}

function validateSelector(serverId: string, languageId: string, selector: string): void {
	const invalid = (
		selector.length === 0
		|| selector.startsWith("/")
		|| selector.startsWith("./")
		|| selector.startsWith("!")
		|| selector.includes("\\")
		|| /^[A-Za-z]:/.test(selector)
		|| selector.split("/").includes("..")
		|| /[?*+@!]\(/.test(selector)
	);
	if (invalid) {
		throw new LspRoutingError(
			`LSP server "${serverId}" has invalid selector ${JSON.stringify(selector)} for "${languageId}"`,
		);
	}
}

function normalizeRelativePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
