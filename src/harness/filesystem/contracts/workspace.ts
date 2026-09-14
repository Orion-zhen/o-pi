import type { ContentOperations } from "./content.ts";
import type { DiscoveryOperations } from "./discovery.ts";
import type { MetadataOperations } from "./metadata.ts";
import type { MutationOperations } from "./mutation.ts";
import type { DirectoryRef, PathOperations } from "./path.ts";
import type { VisibilityOperations } from "./visibility.ts";

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
	readonly discovery: DiscoveryOperations;
	readonly mutations: MutationOperations;
}
