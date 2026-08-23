import path from "node:path";
import picomatch, { type Matcher } from "picomatch";
import {
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	FileChangeType,
	type FileEvent,
	type WorkspaceFolder,
} from "vscode-languageserver-protocol";

import type { LspJsonValue } from "../types.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "./uri.js";

const MAX_CONFIG_ITEMS = 100;
const MAX_REGISTRATIONS = 128;
const MAX_REGISTRATIONS_PER_REQUEST = 64;
const MAX_WATCHERS = 512;
const MAX_WATCHERS_PER_REGISTRATION = 128;
const MAX_GLOB_LENGTH = 1024;
const MAX_ID_LENGTH = 128;
const MAX_SECTION_LENGTH = 256;

const WATCHED_FILES_METHOD = DidChangeWatchedFilesNotification.method;
const CONFIGURATION_METHOD = DidChangeConfigurationNotification.method;
const REGISTRATION_METHODS = new Set<string>([WATCHED_FILES_METHOD, CONFIGURATION_METHOD]);

type DynamicRegistration =
	| { method: typeof WATCHED_FILES_METHOD; watchers: CompiledWatcher[] }
	| { method: typeof CONFIGURATION_METHOD };

interface CompiledWatcher {
	basePath: string;
	kind: number;
	matcher: Matcher;
}

export class LspProtocolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspProtocolValidationError";
	}
}

/** 无项目读取或进程副作用的 client protocol 状态。 */
export class LspProtocolInfrastructure {
	private readonly registrations = new Map<string, DynamicRegistration>();
	private readonly workspaceFolder: WorkspaceFolder;

	constructor(
		private readonly root: string,
		private readonly settings: LspJsonValue | undefined,
	) {
		this.workspaceFolder = { uri: pathToFileUri(root), name: path.basename(root) || root };
	}

	workspaceFolders(): WorkspaceFolder[] {
		return [{ ...this.workspaceFolder }];
	}

	configuration(params: unknown): LspJsonValue[] {
		if (!isRecord(params) || !Array.isArray(params.items) || params.items.length > MAX_CONFIG_ITEMS) {
			throw new LspProtocolValidationError("workspace/configuration items are invalid");
		}
		return params.items.map((item) => {
			if (!isRecord(item)) throw new LspProtocolValidationError("workspace/configuration item is invalid");
			if (item.scopeUri !== undefined) {
				if (typeof item.scopeUri !== "string") throw new LspProtocolValidationError("configuration scopeUri must be a URI");
				const scopePath = fileUriToPath(item.scopeUri);
				if (scopePath === undefined || workspaceRelativePath(this.root, scopePath) === undefined) return null;
			}
			if (item.section !== undefined && typeof item.section !== "string") {
				throw new LspProtocolValidationError("configuration section must be a string");
			}
			return configurationSection(this.settings, item.section);
		});
	}

	configurationSettings(): LspJsonValue | undefined {
		return this.settings === undefined ? undefined : structuredClone(this.settings);
	}

	registerCapabilities(params: unknown): void {
		if (!isRecord(params) || !Array.isArray(params.registrations)) {
			throw new LspProtocolValidationError("client/registerCapability registrations are invalid");
		}
		const input = params.registrations;
		if (input.length > MAX_REGISTRATIONS_PER_REQUEST || this.registrations.size + input.length > MAX_REGISTRATIONS) {
			throw new LspProtocolValidationError("client/registerCapability registration limit exceeded");
		}

		const pending = new Map<string, DynamicRegistration>();
		let watcherCount = countWatchers(this.registrations.values());
		for (const registration of input) {
			if (!isRecord(registration)) throw new LspProtocolValidationError("dynamic registration is invalid");
			if (!safeIdentifier(registration.id)) throw new LspProtocolValidationError("dynamic registration id is invalid");
			if (this.registrations.has(registration.id) || pending.has(registration.id)) {
				throw new LspProtocolValidationError(`dynamic registration id is duplicated: ${registration.id}`);
			}
			if (typeof registration.method !== "string" || !REGISTRATION_METHODS.has(registration.method)) {
				throw new LspProtocolValidationError(`dynamic registration method is not allowed: ${String(registration.method)}`);
			}
			const parsed: DynamicRegistration = registration.method === WATCHED_FILES_METHOD
				? { method: WATCHED_FILES_METHOD, watchers: compileWatchers(this.root, registration.registerOptions) }
				: parseConfigurationRegistration(registration.registerOptions);
			watcherCount += parsed.method === WATCHED_FILES_METHOD ? parsed.watchers.length : 0;
			if (watcherCount > MAX_WATCHERS) throw new LspProtocolValidationError("watched-files registration limit exceeded");
			pending.set(registration.id, parsed);
		}
		for (const [id, registration] of pending) this.registrations.set(id, registration);
	}

	watchedFileEvent(filePath: string, type: FileChangeType): FileEvent | undefined {
		if (workspaceRelativePath(this.root, filePath) === undefined) return undefined;
		for (const registration of this.registrations.values()) {
			if (registration.method !== WATCHED_FILES_METHOD) continue;
			for (const watcher of registration.watchers) {
				if ((watcher.kind & type) === 0) continue;
				const relative = workspaceRelativePath(watcher.basePath, filePath);
				if (relative !== undefined && watcher.matcher(relative === "." ? "" : relative)) {
					return { uri: pathToFileUri(filePath), type };
				}
			}
		}
		return undefined;
	}

	reset(): void {
		this.registrations.clear();
	}
}

function countWatchers(registrations: Iterable<DynamicRegistration>): number {
	let count = 0;
	for (const registration of registrations) {
		if (registration.method === WATCHED_FILES_METHOD) count += registration.watchers.length;
	}
	return count;
}

function compileWatchers(root: string, value: unknown): CompiledWatcher[] {
	if (!isRecord(value) || !Array.isArray(value.watchers) || value.watchers.length === 0 || value.watchers.length > MAX_WATCHERS_PER_REGISTRATION) {
		throw new LspProtocolValidationError("watched-files registration must contain bounded watchers");
	}
	return value.watchers.map((watcher) => compileWatcher(root, watcher));
}

function compileWatcher(root: string, value: unknown): CompiledWatcher {
	if (!isRecord(value)) throw new LspProtocolValidationError("watched-files watcher is invalid");
	const kind = value.kind === undefined ? 7 : value.kind;
	if (!Number.isInteger(kind) || typeof kind !== "number" || kind < 1 || kind > 7) {
		throw new LspProtocolValidationError("watched-files watcher kind is invalid");
	}
	const { basePath, pattern } = parseGlobPattern(root, value.globPattern);
	try {
		return { basePath, kind, matcher: picomatch(pattern, { dot: true, nonegate: true }) };
	} catch {
		throw new LspProtocolValidationError("watched-files glob pattern is invalid");
	}
}

function parseGlobPattern(root: string, value: unknown): { basePath: string; pattern: string } {
	if (typeof value === "string") return { basePath: root, pattern: safeGlob(value) };
	if (!isRecord(value) || typeof value.pattern !== "string") {
		throw new LspProtocolValidationError("watched-files glob pattern is invalid");
	}
	const baseUri = typeof value.baseUri === "string"
		? value.baseUri
		: isRecord(value.baseUri) && typeof value.baseUri.uri === "string" ? value.baseUri.uri : undefined;
	if (baseUri === undefined) throw new LspProtocolValidationError("watched-files relative pattern baseUri is invalid");
	const basePath = fileUriToPath(baseUri);
	if (basePath === undefined || workspaceRelativePath(root, basePath) === undefined) {
		throw new LspProtocolValidationError("watched-files relative pattern must stay inside the workspace");
	}
	return { basePath, pattern: safeGlob(value.pattern) };
}

function safeGlob(value: string): string {
	if (
		value.length === 0
		|| value.length > MAX_GLOB_LENGTH
		|| value.includes("\0")
		|| value.includes("\\")
		|| value.startsWith("/")
		|| /^[A-Za-z]:/u.test(value)
		|| value.split("/").includes("..")
	) throw new LspProtocolValidationError("watched-files glob pattern is unsafe");
	return value;
}

function parseConfigurationRegistration(value: unknown): DynamicRegistration {
	if (value === undefined) return { method: CONFIGURATION_METHOD };
	if (!isRecord(value)) throw new LspProtocolValidationError("configuration registration options are invalid");
	for (const key of Object.keys(value)) {
		if (key !== "section") throw new LspProtocolValidationError("configuration registration option is not allowed");
	}
	const sections = value.section === undefined ? [] : typeof value.section === "string" ? [value.section] : value.section;
	if (!Array.isArray(sections) || sections.length > 32 || sections.some((section) => typeof section !== "string" || section.length > MAX_SECTION_LENGTH)) {
		throw new LspProtocolValidationError("configuration registration section is invalid");
	}
	return { method: CONFIGURATION_METHOD };
}

function configurationSection(settings: LspJsonValue | undefined, section: string | undefined): LspJsonValue {
	if (settings === undefined) return null;
	if (section === undefined || section.length === 0) return structuredClone(settings);
	let value: LspJsonValue = settings;
	for (const segment of section.split(".")) {
		if (!isJsonObject(value) || !Object.hasOwn(value, segment)) return null;
		const nested = value[segment];
		if (nested === undefined) return null;
		value = nested;
	}
	return structuredClone(value);
}

function safeIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: LspJsonValue): value is { [key: string]: LspJsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
