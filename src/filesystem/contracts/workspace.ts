import type { PathCatalogOperations } from "./catalog.js";
import type { ContentOperations } from "./content.js";
import type { MetadataOperations } from "./metadata.js";
import type { MutationOperations } from "./mutation.js";
import type { DirectoryRef, PathOperations } from "./path.js";
import type { TraversalOperations } from "./traversal.js";
import type { VisibilityOperations } from "./visibility.js";

declare const workspaceIdentityBrand: unique symbol;

/** Stable opaque cache namespace for one canonical workspace root. */
export type WorkspaceIdentity = string & { readonly [workspaceIdentityBrand]: "filesystem-workspace" };

/** Filesystem data plane bound to one workspace and immutable invocation policy. */
export interface WorkspaceFileSystem {
	readonly identity: WorkspaceIdentity;
	readonly root: DirectoryRef;
	readonly paths: PathOperations;
	readonly metadata: MetadataOperations;
	readonly content: ContentOperations;
	readonly visibility: VisibilityOperations;
	readonly traversal: TraversalOperations;
	readonly mutations: MutationOperations;
	readonly catalog: PathCatalogOperations;
}
