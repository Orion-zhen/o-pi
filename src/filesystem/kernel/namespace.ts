import path from "node:path";

import type { FilesystemMount, FilesystemPathAccess } from "../contracts/access.js";
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
	readonly pathAccess?: FilesystemPathAccess;
	readonly homeDirectory?: string;
	readonly native?: NativeFileSystem;
	readonly context?: FsOperationContext;
}

export interface NativePathIdentity {
	readonly nativePath: string;
	readonly canonicalPath: string;
	readonly lexicalPath: string;
	readonly namespacePath: string;
	readonly mountLogicalRoot?: string;
	readonly mountNativeRoot?: string;
	readonly parentPath: string;
}

type UnstoredNativePathIdentity = Omit<NativePathIdentity, "parentPath">;

type LexicalPathIdentity = PathIdentity & {
	readonly absolutePath: string;
	readonly namespacePath: string;
	readonly mountLogicalRoot?: string;
	readonly mountNativeRoot?: string;
};

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
		...(options.pathAccess === undefined ? {} : { pathAccess: options.pathAccess }),
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
	private readonly mounts: readonly FilesystemMount[];
	private readonly protectedRoots: readonly string[];
	private readonly managedSchemes: ReadonlySet<string>;

	constructor(private readonly options: {
		readonly workspaceRoot: string;
		readonly blockedPaths: readonly string[];
		readonly pathAccess?: FilesystemPathAccess;
		readonly homeDirectory?: string;
		readonly native: NativeFileSystem;
		readonly context: FsOperationContext;
	}) {
		this.homeDirectory = options.homeDirectory;
		this.mounts = options.pathAccess?.mounts ?? [];
		this.protectedRoots = options.pathAccess?.protectedRoots ?? [];
		this.managedSchemes = new Set(options.pathAccess?.managedSchemes ?? []);
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
		const lexicalAccess = this.validateNamespaceAccess(lexical.value, lexical.value.absolutePath);
		if (!lexicalAccess.ok) return lexicalAccess;
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
		const canonicalAccess = this.validateNamespaceAccess(lexical.value, canonicalPath);
		if (!canonicalAccess.ok) return canonicalAccess;
		const canonicalBlock = this.policy.match(input, this.canonicalIdentity(canonicalPath, lexical.value), "canonical");
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
			...this.createExistingRef(metadata.kind, lexical.value, this.nativeIdentity(lexical.value, nativePath, canonicalPath)),
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
		const lexicalAccess = this.validateNamespaceAccess(lexical.value, lexical.value.absolutePath);
		if (!lexicalAccess.ok) return lexicalAccess;
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
			const canonicalAccess = this.validateNamespaceAccess(lexical.value, canonicalPath);
			if (!canonicalAccess.ok) return canonicalAccess;
			const canonicalBlock = this.policy.match(input, this.canonicalIdentity(canonicalPath, lexical.value), "canonical");
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
			return fsSuccess(this.createTargetPath(
				lexical.value,
				existingKind,
				this.nativeIdentity(lexical.value, nativePath, canonicalPath),
			));
		}

		const parent = await this.resolveNearestExistingParent(lexical.value.absolutePath, lexical.value.displayPath, context);
		if (!parent.ok) return parent;
		const parentAccess = this.validateNamespaceAccess(lexical.value, parent.value.canonicalPath);
		if (!parentAccess.ok) return parentAccess;
		const parentBlock = this.policy.match(input, this.canonicalIdentity(parent.value.canonicalPath, lexical.value), "parent");
		if (parentBlock !== undefined) return blockedFailure(lexical.value.displayPath, parentBlock);
		const canonicalPath = path.resolve(parent.value.canonicalPath, path.relative(parent.value.lexicalPath, lexical.value.absolutePath));
		const targetAccess = this.validateNamespaceAccess(lexical.value, canonicalPath);
		if (!targetAccess.ok) return targetAccess;
		return fsSuccess(this.createTargetPath(
			lexical.value,
			undefined,
			this.nativeIdentity(lexical.value, canonicalPath, canonicalPath),
		));
	}

	relative(parent: DirectoryRef, candidate: ExistingRef | TargetRef): string | undefined {
		const parentIdentity = this.refs.get(parent.id);
		const candidateIdentity = this.refs.get(candidate.id);
		if (parentIdentity === undefined || candidateIdentity === undefined
			|| parentIdentity.mountLogicalRoot !== candidateIdentity.mountLogicalRoot) return undefined;
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
			stored.namespacePath,
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
			childNamespacePath(parentIdentity, name),
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
		const namespacePath = childNamespacePath(parentIdentity, name);
		const resolved = this.resolveLexical(namespacePath);
		if (!resolved.ok) return resolved;
		const lexical = resolved.value;
		const lexicalAccess = this.validateNamespaceAccess(lexical, lexical.absolutePath);
		if (!lexicalAccess.ok) return lexicalAccess;
		const lexicalBlock = this.policy.match(namespacePath, lexical, "lexical");
		if (lexicalBlock !== undefined) return blockedFailure(lexical.displayPath, lexicalBlock);
		const canonicalPath = path.join(parentIdentity.canonicalPath, name);
		const canonicalAccess = this.validateNamespaceAccess(lexical, canonicalPath);
		if (!canonicalAccess.ok) return canonicalAccess;
		const canonicalBlock = this.policy.match(namespacePath, this.canonicalIdentity(canonicalPath, lexical), "canonical");
		if (canonicalBlock !== undefined) return blockedFailure(lexical.displayPath, canonicalBlock);
		const nativeIdentity = this.nativeIdentity(lexical, path.join(parentIdentity.nativePath, name), canonicalPath);
		return kind === "file"
			? fsSuccess(this.createExistingRef("file", lexical, nativeIdentity).ref)
			: fsSuccess(this.createExistingRef("directory", lexical, nativeIdentity).ref);
	}

	getNativeIdentity(ref: ExistingRef | TargetRef): NativePathIdentity | undefined {
		return this.refs.get(ref.id);
	}

	private resolveLexical(input: string): FsResult<LexicalPathIdentity> {
		if (input.length === 0) return fsFailure({ code: "invalid-path", message: "Path must not be empty.", path: input });
		if (input.includes("\0")) return fsFailure({ code: "invalid-path", message: "Path must not contain NUL bytes.", path: input });

		const mount = this.mounts.find((candidate) => input === candidate.logicalRoot || input.startsWith(`${candidate.logicalRoot}/`));
		if (mount !== undefined) {
			const relativePath = input === mount.logicalRoot ? "" : input.slice(mount.logicalRoot.length + 1);
			if (input.includes("\\") || input.includes("?") || input.includes("#") || input.includes("%")
				|| (relativePath.length > 0 && relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".."))) {
				return fsFailure({ code: "invalid-path", message: "Mounted path syntax is invalid.", path: input });
			}
			return fsSuccess({
				displayPath: input,
				absolutePath: relativePath.length === 0 ? mount.nativeRoot : path.join(mount.nativeRoot, ...relativePath.split("/")),
				namespacePath: input,
				mountLogicalRoot: mount.logicalRoot,
				mountNativeRoot: mount.nativeRoot,
			});
		}

		const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(input)?.[1]?.toLowerCase();
		if (scheme !== undefined) {
			return this.managedSchemes.has(scheme)
				? fsFailure({ code: "access-denied", message: "Mounted path is not authorized.", path: input })
				: fsFailure({ code: "invalid-path", message: "Resource locators are not filesystem paths.", path: input });
		}
		const expanded = expandHomePath(input, this.homeDirectory);
		const absolutePath = resolveNativeInputPath(this.options.workspaceRoot, input, this.homeDirectory);
		const workspacePath = workspaceRelativePath(this.options.workspaceRoot, absolutePath);
		const displayPath = workspacePath
			?? (path.isAbsolute(expanded) ? path.normalize(absolutePath) : normalizeLogicalPath(path.relative(this.options.workspaceRoot, absolutePath)));
		return fsSuccess({
			displayPath,
			absolutePath,
			namespacePath: absolutePath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		});
	}

	private canonicalIdentity(canonicalPath: string, lexical: LexicalPathIdentity): PathIdentity {
		if (lexical.mountLogicalRoot !== undefined) {
			return { displayPath: lexical.displayPath, absolutePath: canonicalPath };
		}
		const workspacePath = workspaceRelativePath(this.options.workspaceRoot, canonicalPath);
		return {
			displayPath: workspacePath ?? path.normalize(canonicalPath),
			absolutePath: canonicalPath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		};
	}

	private nativeIdentity(lexical: LexicalPathIdentity, nativePath: string, canonicalPath: string): UnstoredNativePathIdentity {
		return {
			nativePath,
			canonicalPath,
			lexicalPath: lexical.absolutePath,
			namespacePath: lexical.namespacePath,
			...(lexical.mountLogicalRoot === undefined ? {} : {
				mountLogicalRoot: lexical.mountLogicalRoot,
				mountNativeRoot: lexical.mountNativeRoot,
			}),
		};
	}

	private validateNamespaceAccess(lexical: LexicalPathIdentity, candidate: string): FsResult<void> {
		if (lexical.mountNativeRoot !== undefined) {
			if (isInsideOrEqualPath(lexical.mountNativeRoot, candidate)) return fsSuccess(undefined);
			return fsFailure({
				code: "access-denied",
				message: "Mounted path escapes its authorized root.",
				path: lexical.displayPath,
			});
		}
		if (!this.protectedRoots.some((root) => isInsideOrEqualPath(root, candidate))) return fsSuccess(undefined);
		return fsFailure({
			code: "access-denied",
			message: "Managed resources must be accessed through an authorized logical path.",
			path: lexical.displayPath,
		});
	}

	private async resolveDanglingSymlinkTarget(
		input: string,
		identity: LexicalPathIdentity,
		options: ResolveTargetOptions,
		context: FsOperationContext,
	): Promise<FsResult<ResolvedTargetPath>> {
		if (!options.followExistingSymlink) {
			return fsSuccess(this.createTargetPath(
				identity,
				"symlink",
				this.nativeIdentity(identity, identity.absolutePath, identity.absolutePath),
			));
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
		identity: LexicalPathIdentity,
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
			const canonicalAccess = this.validateNamespaceAccess(identity, canonicalPath);
			if (!canonicalAccess.ok) return canonicalAccess;
			const canonicalBlock = this.policy.match(input, this.canonicalIdentity(canonicalPath, identity), "canonical");
			if (canonicalBlock !== undefined) return blockedFailure(identity.displayPath, canonicalBlock);
			return fsSuccess(this.createTargetPath(
				identity,
				metadata.kind,
				this.nativeIdentity(identity, canonicalPath, canonicalPath),
			));
		}
		const parent = await this.resolveNearestExistingParent(targetPath, identity.displayPath, context);
		if (!parent.ok) return parent;
		const parentAccess = this.validateNamespaceAccess(identity, parent.value.canonicalPath);
		if (!parentAccess.ok) return parentAccess;
		const parentBlock = this.policy.match(input, this.canonicalIdentity(parent.value.canonicalPath, identity), "parent");
		if (parentBlock !== undefined) return blockedFailure(identity.displayPath, parentBlock);
		const canonicalPath = path.resolve(parent.value.canonicalPath, path.relative(parent.value.lexicalPath, targetPath));
		const targetAccess = this.validateNamespaceAccess(identity, canonicalPath);
		if (!targetAccess.ok) return targetAccess;
		return fsSuccess(this.createTargetPath(
			identity,
			undefined,
			this.nativeIdentity(identity, canonicalPath, canonicalPath),
		));
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

function childNamespacePath(parent: NativePathIdentity, name: string): string {
	return parent.mountLogicalRoot === undefined
		? path.join(parent.namespacePath, name)
		: `${parent.namespacePath}/${name}`;
}

function isInsideOrEqualPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
