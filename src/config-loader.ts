import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export { expandHomePath, userCachePath } from "./cache-path.js";

export type ConfigErrorFactory<E extends Error> = (message: string, details?: Record<string, unknown>) => E;

export interface ReadJsoncConfigOptions<E extends Error> {
	path: string;
	label: string;
	createError: ConfigErrorFactory<E>;
}

export interface ReadJsoncConfigWithSchemaOptions<E extends Error> extends ReadJsoncConfigOptions<E> {
	loadValidator: () => Promise<ValidateFunction>;
}

export interface SchemaValidatorOptions<E extends Error> {
	schemaPath: string;
	label: string;
	createError: ConfigErrorFactory<E>;
}

export async function readOptionalJsoncConfig<E extends Error>(options: ReadJsoncConfigOptions<E>): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(options.path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw options.createError(`${options.label} config cannot be read.`, { path: options.path });
	}

	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0];
		throw options.createError(`${options.label} config is not valid JSONC.`, {
			path: options.path,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}
	return value;
}

export async function readOptionalJsoncConfigWithSchema<E extends Error>(
	options: ReadJsoncConfigWithSchemaOptions<E>,
): Promise<unknown | undefined> {
	const value = await readOptionalJsoncConfig(options);
	if (value === undefined) return undefined;
	const validator = await options.loadValidator();
	if (!validator(value)) {
		throw options.createError(`${options.label} config does not match schema.`, {
			path: options.path,
			errors: validator.errors ?? [],
		});
	}
	return value;
}

export function createSchemaValidator<E extends Error>(options: SchemaValidatorOptions<E>): () => Promise<ValidateFunction> {
	let compiledValidator: ValidateFunction | undefined;
	return async () => {
		if (compiledValidator !== undefined) return compiledValidator;
		let schema: object;
		try {
			schema = JSON.parse(await readFile(options.schemaPath, "utf8")) as object;
		} catch {
			throw options.createError(`${options.label} schema cannot be read.`, { path: options.schemaPath });
		}
		const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
		try {
			compiledValidator = ajv.compile(schema);
		} catch (error) {
			throw options.createError(`${options.label} schema is invalid.`, {
				path: options.schemaPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return compiledValidator;
	};
}

export function repoRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function agentPath(...segments: string[]): string {
	return path.join(repoRoot(), "agent", ...segments);
}

export function agentConfigPath(fileName: string, envName: string): string {
	return process.env[envName] ?? agentPath("configs", fileName);
}

export function agentSchemaPath(fileName: string): string {
	return agentPath("schemas", fileName);
}

export function userAgentConfigPath(fileName: string, envName: string): string {
	return process.env[envName] ?? path.join(os.homedir(), ".pi", "agent", "configs", fileName);
}

export function userAgentPath(fileName: string, envName: string): string {
	return process.env[envName] ?? path.join(os.homedir(), ".pi", "agent", fileName);
}

export function projectAgentConfigPath(cwd: string, fileName: string, configEnvName: string, rootEnvName: string): string | undefined {
	if (process.env[configEnvName]) return process.env[configEnvName];
	const root = process.env[rootEnvName] ?? findNearestProjectRoot(cwd);
	return root === undefined ? undefined : path.join(root, ".pi", "configs", fileName);
}

export function projectPiPath(cwd: string, fileName: string, configEnvName: string, rootEnvName: string): string | undefined {
	if (process.env[configEnvName]) return process.env[configEnvName];
	const root = process.env[rootEnvName] ?? findNearestProjectRoot(cwd);
	return root === undefined ? undefined : path.join(root, ".pi", fileName);
}

export function findNearestProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(current, ".pi"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
