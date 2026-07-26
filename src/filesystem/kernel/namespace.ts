import path from "node:path";

import type {
	DirectoryRef,
	ExistingPathKind,
	ExistingRef,
	PathId,
	PathOperations,
	ResolveExistingOptions,
	ResolveTargetOptions,
	TargetRef,
} from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsError, type FsOperationContext, type FsResult } from "../contracts/result.js";
import {
	expandHomePath,
	normalizeLogicalPath,
	resolveNativeInputPath,
	WorkspaceAccessPolicy,
	type BlockedPathMatch,
	type PathIdentity,
} from "./access-policy.js";
import {
	NodeNativeFileSystem,
	type NativeFileSystem,
	type NativeMetadata,
	type NativePathKind,
} from "../platform/node/native-filesystem.js";
import { isNativeError, mapNativeError } from "./native-error.js";

export interface WorkspaceNamespaceOptions {
	readonly workspaceRoot: string;
	readonly blockedPaths: readonly string[];
	readonly homeDirectory?: string;
	readonly native?: NativeFileSystem;
	readonly context?: FsOperationContext;
}

export interface NativePathIdentity {
	readonly nativePath: string;
	readonly canonicalPath: string;
	readonly lexicalPath: string;
	readonly parentPath: string;
}

type UnstoredNativePathIdentity = Omit<NativePathIdentity, "parentPath">;

/** Host-only bridge. Tool commands must use opaque refs instead. */
export interface WorkspaceNamespaceBridge {
	getNativeIdentity(ref: ExistingRef | TargetRef): NativePathIdentity | undefined;
	resolveChild(parent: DirectoryRef, name: string, context: FsOperationContext): Promise<FsResult<ExistingRef>>;
}

export interface WorkspaceNamespaceKernel {
	readonly root: DirectoryRef;
	readonly paths: PathOperations;
	readonly bridge: WorkspaceNamespaceBridge;
}

let nextNamespaceId = 1;

export async function createWorkspaceNamespace(options: WorkspaceNamespaceOptions): Promise<FsResult<WorkspaceNamespaceKernel>> {
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const operations = new NamespacePathOperations({
		workspaceRoot,
		...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		blockedPaths: options.blockedPaths,
		native: options.native ?? new NodeNativeFileSystem(),
	});
	const rootResult = await operations.resolveExisting(
		".",
		{ expected: "any", followFinalSymlink: true },
		options.context ?? {},
	);
	if (!rootResult.ok) return rootResult;
	if (rootResult.value.kind !== "directory") {
		return fsFailure({ code: "not-directory", message: "Workspace root is not a directory.", path: "." });
	}
	return fsSuccess({ root: rootResult.value, paths: operations, bridge: operations });
}

class NamespacePathOperations implements PathOperations, WorkspaceNamespaceBridge {
	private readonly namespaceId = nextNamespaceId++;
	private nextRefId = 1;
	private readonly refs = new Map<PathId, NativePathIdentity>();
	private readonly policy: WorkspaceAccessPolicy;
	private readonly homeDirectory: string | undefined;

	constructor(private readonly options: {
		readonly workspaceRoot: string;
		readonly blockedPaths: readonly string[];
		readonly homeDirectory?: string;
		readonly native: NativeFileSystem;
	}) {
		this.homeDirectory = options.homeDirectory;
		this.policy = new WorkspaceAccessPolicy({
			blockedPaths: options.blockedPaths,
			...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		});
	}

	async resolveExisting(
		input: string,
		options: ResolveExistingOptions,
		context: FsOperationContext,
	): Promise<FsResult<ExistingRef>> {
		const lexical = this.resolveLexical(input);
		if (!lexical.ok) return lexical;
		const lexicalBlock = this.policy.match(input, lexical.value, "lexical");
		if (lexicalBlock !== undefined) return blockedFailure(lexical.value.displayPath, lexicalBlock);

		let lexicalMetadata: NativeMetadata;
		try {
			lexicalMetadata = await this.options.native.lstat(lexical.value.absolutePath, context);
		} catch (error) {
			return fsFailure(mapNativeError(error, lexical.value.displayPath));
		}

		let canonicalPath: string;
		try {
			canonicalPath = await this.options.native.realpath(lexical.value.absolutePath, context);
		} catch (error) {
			if (lexicalMetadata.kind === "symlink" && !options.followFinalSymlink && isNativeError(error, "not-found")) {
				canonicalPath = lexical.value.absolutePath;
			} else {
				return fsFailure(mapNativeError(error, lexical.value.displayPath));
			}
		}
		const canonicalBlock = this.policy.match(input, this.canonicalIdentity(canonicalPath), "canonical");
		if (canonicalBlock !== undefined) return blockedFailure(lexical.value.displayPath, canonicalBlock);

		let kind: NativePathKind = lexicalMetadata.kind;
		let nativePath = lexical.value.absolutePath;
		if (lexicalMetadata.kind !== "symlink" || options.followFinalSymlink) {
			nativePath = canonicalPath;
			try {
				kind = (await this.options.native.stat(canonicalPath, context)).kind;
			} catch (error) {
				return fsFailure(mapNativeError(error, lexical.value.displayPath));
			}
		}
		const expectedError = validateExpectedKind(kind, options.expected, lexical.value.displayPath);
		if (expectedError !== undefined) return fsFailure(expectedError);
		return fsSuccess(this.createExistingRef(kind, lexical.value, { nativePath, canonicalPath, lexicalPath: lexical.value.absolutePath }));
	}

	async resolveTarget(
		input: string,
		options: ResolveTargetOptions,
		context: FsOperationContext,
	): Promise<FsResult<TargetRef>> {
		const lexical = this.resolveLexical(input);
		if (!lexical.ok) return lexical;
		const lexicalBlock = this.policy.match(input, lexical.value, "lexical");
		if (lexicalBlock !== undefined) return blockedFailure(lexical.value.displayPath, lexicalBlock);

		let lexicalMetadata: NativeMetadata | undefined;
		try {
			lexicalMetadata = await this.options.native.lstat(lexical.value.absolutePath, context);
		} catch (error) {
			if (!isNativeError(error, "not-found")) return fsFailure(mapNativeError(error, lexical.value.displayPath));
		}

		if (lexicalMetadata !== undefined) {
			let canonicalPath: string;
			try {
				canonicalPath = await this.options.native.realpath(lexical.value.absolutePath, context);
			} catch (error) {
				if (lexicalMetadata.kind === "symlink" && isNativeError(error, "not-found")) {
					return this.resolveDanglingSymlinkTarget(input, lexical.value, options, context);
				}
				return fsFailure(mapNativeError(error, lexical.value.displayPath));
			}
			const canonicalBlock = this.policy.match(input, this.canonicalIdentity(canonicalPath), "canonical");
			if (canonicalBlock !== undefined) return blockedFailure(lexical.value.displayPath, canonicalBlock);
			let existingKind = lexicalMetadata.kind;
			let nativePath = lexical.value.absolutePath;
			if (lexicalMetadata.kind !== "symlink" || options.followExistingSymlink) {
				nativePath = canonicalPath;
				try {
					existingKind = (await this.options.native.stat(canonicalPath, context)).kind;
				} catch (error) {
					return fsFailure(mapNativeError(error, lexical.value.displayPath));
				}
			}
			return fsSuccess(this.createTargetRef(lexical.value, existingKind, {
				nativePath,
				canonicalPath,
				lexicalPath: lexical.value.absolutePath,
			}));
		}

		const parent = await this.resolveNearestExistingParent(lexical.value.absolutePath, lexical.value.displayPath, context);
		if (!parent.ok) return parent;
		const parentBlock = this.policy.match(input, this.canonicalIdentity(parent.value.canonicalPath), "parent");
		if (parentBlock !== undefined) return blockedFailure(lexical.value.displayPath, parentBlock);
		const canonicalPath = path.resolve(parent.value.canonicalPath, path.relative(parent.value.lexicalPath, lexical.value.absolutePath));
		return fsSuccess(this.createTargetRef(lexical.value, undefined, {
			nativePath: canonicalPath,
			canonicalPath,
			lexicalPath: lexical.value.absolutePath,
		}));
	}

	isWithin(parent: DirectoryRef, candidate: ExistingRef): boolean {
		const parentIdentity = this.refs.get(parent.id);
		const candidateIdentity = this.refs.get(candidate.id);
		if (parentIdentity === undefined || candidateIdentity === undefined) return false;
		const relative = path.relative(parentIdentity.canonicalPath, candidateIdentity.canonicalPath);
		return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	}

	async resolveChild(parent: DirectoryRef, name: string, context: FsOperationContext): Promise<FsResult<ExistingRef>> {
		const parentIdentity = this.refs.get(parent.id);
		if (parentIdentity === undefined || name.length === 0 || name === "." || name === ".." || path.basename(name) !== name) {
			return fsFailure({ code: "invalid-path", message: "Directory entry is invalid.", path: parent.displayPath });
		}
		return await this.resolveExisting(
			path.join(parentIdentity.lexicalPath, name),
			{ expected: "any", followFinalSymlink: false },
			context,
		);
	}

	getNativeIdentity(ref: ExistingRef | TargetRef): NativePathIdentity | undefined {
		return this.refs.get(ref.id);
	}

	private resolveLexical(input: string): FsResult<PathIdentity & { readonly absolutePath: string }> {
		if (input.length === 0) return fsFailure({ code: "invalid-path", message: "Path must not be empty.", path: input });
		if (input.includes("\0")) return fsFailure({ code: "invalid-path", message: "Path must not contain NUL bytes.", path: input });
		if (input.startsWith("skill://")) {
			return fsFailure({ code: "invalid-path", message: "Resource locators are not filesystem paths.", path: input });
		}
		const expanded = expandHomePath(input, this.homeDirectory);
		const absolutePath = resolveNativeInputPath(this.options.workspaceRoot, input, this.homeDirectory);
		const workspacePath = workspaceRelativePath(this.options.workspaceRoot, absolutePath);
		const displayPath = workspacePath
			?? (path.isAbsolute(expanded) ? path.normalize(absolutePath) : normalizeLogicalPath(path.relative(this.options.workspaceRoot, absolutePath)));
		return fsSuccess({
			displayPath,
			absolutePath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		});
	}

	private canonicalIdentity(canonicalPath: string): PathIdentity {
		const workspacePath = workspaceRelativePath(this.options.workspaceRoot, canonicalPath);
		return {
			displayPath: workspacePath ?? path.normalize(canonicalPath),
			absolutePath: canonicalPath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		};
	}

	private async resolveDanglingSymlinkTarget(
		input: string,
		identity: PathIdentity & { readonly absolutePath: string },
		options: ResolveTargetOptions,
		context: FsOperationContext,
	): Promise<FsResult<TargetRef>> {
		if (!options.followExistingSymlink) {
			return fsSuccess(this.createTargetRef(identity, "symlink", {
				nativePath: identity.absolutePath,
				canonicalPath: identity.absolutePath,
				lexicalPath: identity.absolutePath,
			}));
		}
		let linkTarget: string;
		try {
			linkTarget = await this.options.native.readlink(identity.absolutePath, context);
		} catch (error) {
			return fsFailure(mapNativeError(error, identity.displayPath));
		}
		const targetPath = path.resolve(path.dirname(identity.absolutePath), linkTarget);
		return this.resolveWritableDestination(input, targetPath, identity, context, new Set([identity.absolutePath]));
	}

	private async resolveWritableDestination(
		input: string,
		targetPath: string,
		identity: PathIdentity & { readonly absolutePath: string },
		context: FsOperationContext,
		visited: ReadonlySet<string>,
	): Promise<FsResult<TargetRef>> {
		if (visited.has(targetPath)) {
			return fsFailure({ code: "invalid-path", message: "Symbolic link cycle cannot be resolved.", path: identity.displayPath });
		}
		let metadata: NativeMetadata | undefined;
		try {
			metadata = await this.options.native.lstat(targetPath, context);
		} catch (error) {
			if (!isNativeError(error, "not-found")) return fsFailure(mapNativeError(error, identity.displayPath));
		}
		if (metadata?.kind === "symlink") {
			let linkTarget: string;
			try {
				linkTarget = await this.options.native.readlink(targetPath, context);
			} catch (error) {
				return fsFailure(mapNativeError(error, identity.displayPath));
			}
			const nextVisited = new Set(visited);
			nextVisited.add(targetPath);
			return this.resolveWritableDestination(
				input,
				path.resolve(path.dirname(targetPath), linkTarget),
				identity,
				context,
				nextVisited,
			);
		}
		if (metadata !== undefined) {
			let canonicalPath: string;
			try {
				canonicalPath = await this.options.native.realpath(targetPath, context);
			} catch (error) {
				return fsFailure(mapNativeError(error, identity.displayPath));
			}
			const canonicalBlock = this.policy.match(input, this.canonicalIdentity(canonicalPath), "canonical");
			if (canonicalBlock !== undefined) return blockedFailure(identity.displayPath, canonicalBlock);
			return fsSuccess(this.createTargetRef(identity, metadata.kind, {
				nativePath: canonicalPath,
				canonicalPath,
				lexicalPath: identity.absolutePath,
			}));
		}
		const parent = await this.resolveNearestExistingParent(targetPath, identity.displayPath, context);
		if (!parent.ok) return parent;
		const parentBlock = this.policy.match(input, this.canonicalIdentity(parent.value.canonicalPath), "parent");
		if (parentBlock !== undefined) return blockedFailure(identity.displayPath, parentBlock);
		const canonicalPath = path.resolve(parent.value.canonicalPath, path.relative(parent.value.lexicalPath, targetPath));
		return fsSuccess(this.createTargetRef(identity, undefined, {
			nativePath: canonicalPath,
			canonicalPath,
			lexicalPath: identity.absolutePath,
		}));
	}

	private async resolveNearestExistingParent(
		targetPath: string,
		displayPath: string,
		context: FsOperationContext,
	): Promise<FsResult<{ readonly lexicalPath: string; readonly canonicalPath: string }>> {
		let current = path.dirname(targetPath);
		while (true) {
			try {
				const canonicalPath = await this.options.native.realpath(current, context);
				let metadata: NativeMetadata;
				try {
					metadata = await this.options.native.stat(canonicalPath, context);
				} catch (error) {
					return fsFailure(mapNativeError(error, displayPath));
				}
				if (metadata.kind !== "directory") {
					return fsFailure({ code: "not-directory", message: "Writable parent is not a directory.", path: displayPath });
				}
				return fsSuccess({ lexicalPath: current, canonicalPath });
			} catch (error) {
				if (!isNativeError(error, "not-found")) return fsFailure(mapNativeError(error, displayPath));
				const next = path.dirname(current);
				if (next === current) return fsFailure(mapNativeError(error, displayPath));
				current = next;
			}
		}
	}

	private createExistingRef(
		kind: NativePathKind,
		identity: PathIdentity,
		nativeIdentity: UnstoredNativePathIdentity,
	): ExistingRef {
		const base = this.createRefBase(identity, nativeIdentity);
		if (kind === "file") return { ...base, kind: "file" };
		if (kind === "directory") return { ...base, kind: "directory" };
		if (kind === "symlink") return { ...base, kind: "symlink" };
		return { ...base, kind: "other" };
	}

	private createTargetRef(
		identity: PathIdentity,
		existingKind: ExistingPathKind | undefined,
		nativeIdentity: UnstoredNativePathIdentity,
	): TargetRef {
		return {
			...this.createRefBase(identity, nativeIdentity),
			kind: "target",
			...(existingKind === undefined ? {} : { existingKind }),
		};
	}

	private createRefBase(identity: PathIdentity, nativeIdentity: UnstoredNativePathIdentity): {
		readonly id: PathId;
		readonly displayPath: string;
		readonly workspacePath?: string;
	} {
		const id = `namespace-${this.namespaceId}:ref-${this.nextRefId++}` as PathId;
		this.refs.set(id, { ...nativeIdentity, parentPath: path.dirname(nativeIdentity.nativePath) });
		return {
			id,
			displayPath: identity.displayPath,
			...(identity.workspacePath === undefined ? {} : { workspacePath: identity.workspacePath }),
		};
	}
}

function workspaceRelativePath(workspaceRoot: string, candidate: string): string | undefined {
	const relative = path.relative(workspaceRoot, candidate);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return normalizeLogicalPath(relative);
}

function validateExpectedKind(
	kind: NativePathKind,
	expected: ResolveExistingOptions["expected"],
	displayPath: string,
): FsError | undefined {
	if (expected === "file" && kind !== "file") return { code: "not-file", message: "Path is not a regular file.", path: displayPath };
	if (expected === "directory" && kind !== "directory") return { code: "not-directory", message: "Path is not a directory.", path: displayPath };
	return undefined;
}

function blockedFailure(displayPath: string, match: BlockedPathMatch): FsResult<never> {
	return fsFailure({
		code: "blocked",
		message: match.message,
		path: displayPath,
		details: {
			code: match.code,
			matchedRule: match.matchedRule,
			matchedPath: match.matchedPath,
			phase: match.phase,
		},
	});
}
