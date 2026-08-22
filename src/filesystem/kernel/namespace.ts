import path from "node:path";

import type {
	DirectoryRef,
	ExistingPathKind,
	ExistingRef,
	FileRef,
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
export interface ResolvedExistingPath<TRef extends ExistingRef = ExistingRef> {
	readonly ref: TRef;
	readonly identity: NativePathIdentity;
	readonly metadata: NativeMetadata;
}

export type ResolvedTargetPath =
	| {
		readonly target: TargetRef & { readonly existingKind?: undefined };
		readonly identity: NativePathIdentity;
	}
	| {
		readonly target: TargetRef & { readonly existingKind: ExistingPathKind };
		readonly identity: NativePathIdentity;
		readonly existing: ExistingRef;
	};

export interface WorkspaceNamespaceBridge {
	getNativeIdentity(ref: ExistingRef | TargetRef): NativePathIdentity | undefined;
	resolveTargetPath(input: string, options: ResolveTargetOptions): Promise<FsResult<ResolvedTargetPath>>;
	revalidateExisting(ref: ExistingRef): Promise<FsResult<ResolvedExistingPath>>;
	resolveChild(parent: DirectoryRef, name: string): Promise<FsResult<ResolvedExistingPath>>;
	/** Projects one trusted regular dirent snapshot without additional metadata I/O. */
	projectListedChild(parent: DirectoryRef, name: string, kind: "file"): FsResult<FileRef>;
	projectListedChild(parent: DirectoryRef, name: string, kind: "directory"): FsResult<DirectoryRef>;
}

export interface WorkspaceNamespaceKernel {
	readonly root: DirectoryRef;
	readonly rootIdentity: NativePathIdentity;
	readonly paths: PathOperations;
	readonly bridge: WorkspaceNamespaceBridge;
}

let nextNamespaceId = 1;

export async function createWorkspaceNamespace(options: WorkspaceNamespaceOptions): Promise<FsResult<WorkspaceNamespaceKernel>> {
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const context = options.context ?? {};
	const operations = new NamespacePathOperations({
		workspaceRoot,
		...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		blockedPaths: options.blockedPaths,
		native: options.native ?? new NodeNativeFileSystem(),
		context,
	});
	const rootResult = await operations.resolveExistingPath(
		".",
		{ expected: "directory", followFinalSymlink: true },
	);
	if (!rootResult.ok) return rootResult;
	return fsSuccess({
		root: rootResult.value.ref,
		rootIdentity: rootResult.value.identity,
		paths: operations,
		bridge: operations,
	});
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
		readonly context: FsOperationContext;
	}) {
		this.homeDirectory = options.homeDirectory;
		this.policy = new WorkspaceAccessPolicy({
			blockedPaths: options.blockedPaths,
			...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		});
	}

	resolveExisting(input: string, options: ResolveExistingOptions & { readonly expected: "file" }): Promise<FsResult<FileRef>>;
	resolveExisting(input: string, options: ResolveExistingOptions & { readonly expected: "directory" }): Promise<FsResult<DirectoryRef>>;
	resolveExisting(input: string, options: ResolveExistingOptions & { readonly expected: "any" }): Promise<FsResult<ExistingRef>>;
	async resolveExisting(
		input: string,
		options: ResolveExistingOptions,
	): Promise<FsResult<ExistingRef>> {
		const resolved = await this.resolveExistingPath(input, options);
		return resolved.ok ? fsSuccess(resolved.value.ref) : resolved;
	}

	resolveExistingPath(
		input: string,
		options: ResolveExistingOptions & { readonly expected: "file" },
	): Promise<FsResult<ResolvedExistingPath<FileRef>>>;
	resolveExistingPath(
		input: string,
		options: ResolveExistingOptions & { readonly expected: "directory" },
	): Promise<FsResult<ResolvedExistingPath<DirectoryRef>>>;
	resolveExistingPath(
		input: string,
		options: ResolveExistingOptions & { readonly expected: "any" },
	): Promise<FsResult<ResolvedExistingPath>>;
	resolveExistingPath(
		input: string,
		options: ResolveExistingOptions,
	): Promise<FsResult<ResolvedExistingPath>>;
	async resolveExistingPath(
		input: string,
		options: ResolveExistingOptions,
	): Promise<FsResult<ResolvedExistingPath>> {
		const context = this.options.context;
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

		let metadata = lexicalMetadata;
		let nativePath = lexical.value.absolutePath;
		if (lexicalMetadata.kind === "symlink" && options.followFinalSymlink) {
			nativePath = canonicalPath;
			try {
				metadata = await this.options.native.stat(canonicalPath, context);
			} catch (error) {
				return fsFailure(mapNativeError(error, lexical.value.displayPath));
			}
		} else if (lexicalMetadata.kind !== "symlink") nativePath = canonicalPath;
		const expectedError = validateExpectedKind(metadata.kind, options.expected, lexical.value.displayPath);
		if (expectedError !== undefined) return fsFailure(expectedError);
		return fsSuccess({
			...this.createExistingRef(metadata.kind, lexical.value, {
				nativePath,
				canonicalPath,
				lexicalPath: lexical.value.absolutePath,
			}),
			metadata,
		});
	}

	async resolveTarget(
		input: string,
		options: ResolveTargetOptions,
	): Promise<FsResult<TargetRef>> {
		const resolved = await this.resolveTargetPath(input, options);
		return resolved.ok ? fsSuccess(resolved.value.target) : resolved;
	}

	async resolveTargetPath(
		input: string,
		options: ResolveTargetOptions,
	): Promise<FsResult<ResolvedTargetPath>> {
		const context = this.options.context;
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
			if (lexicalMetadata.kind === "symlink" && options.followExistingSymlink) {
				nativePath = canonicalPath;
				try {
					existingKind = (await this.options.native.stat(canonicalPath, context)).kind;
				} catch (error) {
					return fsFailure(mapNativeError(error, lexical.value.displayPath));
				}
			} else if (lexicalMetadata.kind !== "symlink") nativePath = canonicalPath;
			return fsSuccess(this.createTargetPath(lexical.value, existingKind, {
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
		return fsSuccess(this.createTargetPath(lexical.value, undefined, {
			nativePath: canonicalPath,
			canonicalPath,
			lexicalPath: lexical.value.absolutePath,
		}));
	}

	relative(parent: DirectoryRef, candidate: ExistingRef | TargetRef): string | undefined {
		const parentIdentity = this.refs.get(parent.id);
		const candidateIdentity = this.refs.get(candidate.id);
		if (parentIdentity === undefined || candidateIdentity === undefined) return undefined;
		const relative = path.relative(parentIdentity.canonicalPath, candidateIdentity.canonicalPath);
		if (relative === "") return "";
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
		return normalizeLogicalPath(relative);
	}

	isWithin(parent: DirectoryRef, candidate: ExistingRef | TargetRef): boolean {
		return this.relative(parent, candidate) !== undefined;
	}

	async revalidateExisting(
		ref: ExistingRef,
	): Promise<FsResult<ResolvedExistingPath>> {
		const stored = this.refs.get(ref.id);
		if (stored === undefined) {
			return fsFailure({ code: "invalid-path", message: "Path does not belong to this filesystem.", path: ref.displayPath });
		}
		const fresh = await this.resolveExistingPath(
			stored.lexicalPath,
			{ expected: "any", followFinalSymlink: true },
		);
		if (!fresh.ok) return fresh;
		return fresh;
	}

	async resolveChild(parent: DirectoryRef, name: string): Promise<FsResult<ResolvedExistingPath>> {
		const parentIdentity = this.refs.get(parent.id);
		if (parentIdentity === undefined || name.length === 0 || name === "." || name === ".." || path.basename(name) !== name) {
			return fsFailure({ code: "invalid-path", message: "Directory entry is invalid.", path: parent.displayPath });
		}
		return await this.resolveExistingPath(
			path.join(parentIdentity.lexicalPath, name),
			{ expected: "any", followFinalSymlink: false },
		);
	}

	projectListedChild(parent: DirectoryRef, name: string, kind: "file"): FsResult<FileRef>;
	projectListedChild(parent: DirectoryRef, name: string, kind: "directory"): FsResult<DirectoryRef>;
	projectListedChild(
		parent: DirectoryRef,
		name: string,
		kind: "file" | "directory",
	): FsResult<FileRef | DirectoryRef> {
		const context = this.options.context;
		const parentIdentity = this.refs.get(parent.id);
		if (context.signal?.aborted === true) {
			return fsFailure({ code: "aborted", message: "Operation aborted.", path: parent.displayPath });
		}
		if (parentIdentity === undefined || name.length === 0 || name === "." || name === ".." || path.basename(name) !== name) {
			return fsFailure({ code: "invalid-path", message: "Directory entry is invalid.", path: parent.displayPath });
		}
		const input = path.join(parentIdentity.lexicalPath, name);
		const workspacePath = parent.workspacePath === undefined
			? undefined
			: normalizeLogicalPath(path.join(parent.workspacePath, name));
		const displayPath = workspacePath
			?? normalizeLogicalPath(input);
		const lexical: PathIdentity & { readonly absolutePath: string } = {
			displayPath,
			absolutePath: input,
			...(workspacePath === undefined ? {} : { workspacePath }),
		};
		const lexicalBlock = this.policy.match(input, lexical, "lexical");
		if (lexicalBlock !== undefined) return blockedFailure(displayPath, lexicalBlock);
		const canonicalPath = path.join(parentIdentity.canonicalPath, name);
		const canonicalBlock = this.policy.match(input, {
			displayPath,
			absolutePath: canonicalPath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		}, "canonical");
		if (canonicalBlock !== undefined) return blockedFailure(displayPath, canonicalBlock);
		const nativeIdentity = {
				nativePath: path.join(parentIdentity.nativePath, name),
				canonicalPath,
				lexicalPath: input,
		};
		return kind === "file"
			? fsSuccess(this.createExistingRef("file", lexical, nativeIdentity).ref)
			: fsSuccess(this.createExistingRef("directory", lexical, nativeIdentity).ref);
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
	): Promise<FsResult<ResolvedTargetPath>> {
		if (!options.followExistingSymlink) {
			return fsSuccess(this.createTargetPath(identity, "symlink", {
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
	): Promise<FsResult<ResolvedTargetPath>> {
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
			return fsSuccess(this.createTargetPath(identity, metadata.kind, {
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
		return fsSuccess(this.createTargetPath(identity, undefined, {
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
		kind: "file",
		identity: PathIdentity,
		nativeIdentity: UnstoredNativePathIdentity,
	): Pick<ResolvedExistingPath<FileRef>, "ref" | "identity">;
	private createExistingRef(
		kind: "directory",
		identity: PathIdentity,
		nativeIdentity: UnstoredNativePathIdentity,
	): Pick<ResolvedExistingPath<DirectoryRef>, "ref" | "identity">;
	private createExistingRef(
		kind: NativePathKind,
		identity: PathIdentity,
		nativeIdentity: UnstoredNativePathIdentity,
	): Pick<ResolvedExistingPath, "ref" | "identity">;
	private createExistingRef(
		kind: NativePathKind,
		identity: PathIdentity,
		nativeIdentity: UnstoredNativePathIdentity,
	): Pick<ResolvedExistingPath, "ref" | "identity"> {
		const stored = this.createRefBase(identity, nativeIdentity);
		if (kind === "file") return { ref: { ...stored.ref, kind: "file" }, identity: stored.identity };
		if (kind === "directory") return { ref: { ...stored.ref, kind: "directory" }, identity: stored.identity };
		if (kind === "symlink") return { ref: { ...stored.ref, kind: "symlink" }, identity: stored.identity };
		return { ref: { ...stored.ref, kind: "other" }, identity: stored.identity };
	}

	private createTargetPath(
		identity: PathIdentity,
		existingKind: ExistingPathKind | undefined,
		nativeIdentity: UnstoredNativePathIdentity,
	): ResolvedTargetPath {
		const stored = this.createRefBase(identity, nativeIdentity);
		if (existingKind === undefined) {
			return { target: { ...stored.ref, kind: "target" }, identity: stored.identity };
		}
		const existing = this.createExistingRef(existingKind, identity, nativeIdentity);
		return {
			target: { ...stored.ref, kind: "target", existingKind },
			identity: stored.identity,
			existing: existing.ref,
		};
	}

	private createRefBase(identity: PathIdentity, nativeIdentity: UnstoredNativePathIdentity): {
		readonly ref: {
			readonly id: PathId;
			readonly displayPath: string;
			readonly workspacePath?: string;
		};
		readonly identity: NativePathIdentity;
	} {
		const id = `namespace-${this.namespaceId}:ref-${this.nextRefId++}` as PathId;
		const storedIdentity = { ...nativeIdentity, parentPath: path.dirname(nativeIdentity.nativePath) };
		this.refs.set(id, storedIdentity);
		return {
			ref: {
				id,
				displayPath: identity.displayPath,
				...(identity.workspacePath === undefined ? {} : { workspacePath: identity.workspacePath }),
			},
			identity: storedIdentity,
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
