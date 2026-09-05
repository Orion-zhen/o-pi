import type { FsResult } from "./result.js";

export type ExistingPathKind = "file" | "directory" | "symlink" | "other";

interface PathRefBase {
	readonly displayPath: string;
	readonly workspacePath?: string;
}

export interface FileRef extends PathRefBase {
	readonly kind: "file";
}

export interface DirectoryRef extends PathRefBase {
	readonly kind: "directory";
}

export interface SymlinkRef extends PathRefBase {
	readonly kind: "symlink";
}

export interface OtherRef extends PathRefBase {
	readonly kind: "other";
}

/** A guarded mutation destination. It may not exist yet. */
export interface TargetRef extends PathRefBase {
	readonly kind: "target";
	readonly existingKind?: ExistingPathKind;
}

export type ExistingRef = FileRef | DirectoryRef | SymlinkRef | OtherRef;
export type AnyPathRef = ExistingRef | TargetRef;

export type ResolveExpectedKind = "any" | "file" | "directory";

export interface ResolveExistingOptions {
	readonly expected: ResolveExpectedKind;
	/** Explicit roots may follow their input symlink; discovered children may not. */
	readonly followFinalSymlink: boolean;
}

export interface PathOperations {
	resolveExisting(input: string, options: ResolveExistingOptions & { readonly expected: "file" }): Promise<FsResult<FileRef>>;
	resolveExisting(input: string, options: ResolveExistingOptions & { readonly expected: "directory" }): Promise<FsResult<DirectoryRef>>;
	resolveExisting(input: string, options: ResolveExistingOptions & { readonly expected: "any" }): Promise<FsResult<ExistingRef>>;
	resolveTarget(input: string): Promise<FsResult<TargetRef>>;
	/** candidate 位于 parent 的 canonical 子树内时，返回以 `/` 规范化的相对路径。 */
	relative(parent: DirectoryRef, candidate: ExistingRef | TargetRef): string | undefined;
	isWithin(parent: DirectoryRef, candidate: ExistingRef | TargetRef): boolean;
}
