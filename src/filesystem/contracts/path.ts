import type { FsOperationContext, FsResult } from "./result.js";

declare const pathIdBrand: unique symbol;

/** Logical identity assigned by the filesystem namespace. */
export type PathId = string & { readonly [pathIdBrand]: "filesystem-path" };

export type ExistingPathKind = "file" | "directory" | "symlink" | "other";

interface PathRefBase {
	readonly id: PathId;
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

export interface ResolveTargetOptions {
	readonly followExistingSymlink: boolean;
}

export interface PathOperations {
	resolveExisting(input: string, options: ResolveExistingOptions, context: FsOperationContext): Promise<FsResult<ExistingRef>>;
	resolveTarget(input: string, options: ResolveTargetOptions, context: FsOperationContext): Promise<FsResult<TargetRef>>;
	isWithin(parent: DirectoryRef, candidate: ExistingRef): boolean;
}
