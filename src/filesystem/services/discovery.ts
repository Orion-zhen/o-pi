import path from "node:path";
import picomatch from "picomatch";

import type {
	Discovery,
	DiscoveryEntryEvent,
	DiscoveryErrorEvent,
	DiscoveryEvent,
	DiscoveryOperations,
	DiscoveryOptions,
	DiscoveryRoot,
	DiscoverySkipEvent,
	PathDiscovery,
	PathDiscoveryEntryEvent,
	PathDiscoveryEvent,
} from "../contracts/discovery.js";
import { toFileSnapshot, type MetadataOperations } from "../contracts/metadata.js";
import type { DirectoryRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import type {
	PathTraversal,
	PathTraversalEvent,
	Traversal,
	TraversalEvent,
	TraversalOperations,
} from "../contracts/traversal.js";
import type { VisibilityOperations } from "../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../kernel/namespace.js";

type DiscoveryEntryKind = "file" | "directory";

interface GlobSelector {
	readonly staticDirectoryPrefix?: string;
	matches(relativePath: string, kind: DiscoveryEntryKind): boolean;
}

interface TraversalStart {
	readonly root: DirectoryRef;
	readonly depthOffset: number;
	readonly relativePrefix: string;
}

interface PrefixSkip {
	readonly event: DiscoveryEvent;
}

/** 组合 namespace、visibility、metadata 和 traversal 的 scope-relative discovery。 */
export class WorkspaceDiscoveryService implements DiscoveryOperations {
	private cachedGlob?: { readonly input: string; readonly result: FsResult<GlobSelector> };

	constructor(
		private readonly namespace: WorkspaceNamespaceKernel,
		private readonly metadata: MetadataOperations,
		private readonly visibility: VisibilityOperations,
		private readonly traversal: TraversalOperations,
		private readonly context: FsOperationContext,
	) {}

	async discover(root: DiscoveryRoot, options: DiscoveryOptions): Promise<FsResult<Discovery>> {
		const context = this.context;
		if (context.signal?.aborted === true) return aborted(root.displayPath);
		let selector: GlobSelector | undefined;
		if (options.glob !== undefined) {
			const compiled = this.compileGlob(options.glob, root.displayPath);
			if (!compiled.ok) return compiled;
			selector = compiled.value;
		}
		return root.kind === "file"
			? await this.discoverFile(root, options, selector)
			: await this.discoverDirectory(root, options, selector);
	}

	async discoverPaths(
		root: DirectoryRef,
		options: DiscoveryOptions,
	): Promise<FsResult<PathDiscovery>> {
		const context = this.context;
		if (context.signal?.aborted === true) return aborted(root.displayPath);
		let selector: GlobSelector | undefined;
		if (options.glob !== undefined) {
			const compiled = this.compileGlob(options.glob, root.displayPath);
			if (!compiled.ok) return compiled;
			selector = compiled.value;
		}
		return await this.discoverPathDirectory(root, options, selector);
	}

	private compileGlob(input: string, rootPath: string): FsResult<GlobSelector> {
		if (this.cachedGlob?.input === input) return this.cachedGlob.result;
		const result = compileGlob(input, rootPath);
		if (result.ok) this.cachedGlob = { input, result };
		return result;
	}

	private async discoverFile(
		root: DiscoveryRoot & { readonly kind: "file" },
		options: DiscoveryOptions,
		selector: GlobSelector | undefined,
	): Promise<FsResult<Discovery>> {
		const identity = this.namespace.bridge.getNativeIdentity(root);
		if (identity === undefined) {
			return fsFailure({ code: "invalid-path", message: "Path does not belong to this filesystem.", path: root.displayPath });
		}
		const relativePath = path.basename(identity.lexicalPath);
		if (selector !== undefined && !selector.matches(relativePath, "file")) return fsSuccess(eventStream([]));
		if (options.maxEntries === 0) {
			return fsSuccess(eventStream([{ type: "skip", path: root.displayPath, reason: "entry-limit", kind: "file" }]));
		}
		const visibility = await this.visibility.evaluate(root, "search");
		if (!visibility.ok) return visibility;
		const metadata = await this.metadata.stat(root);
		if (!metadata.ok) return metadata;
		return fsSuccess(eventStream([{
			type: "entry",
			ref: root,
			relativePath,
			depth: 0,
			snapshot: toFileSnapshot(metadata.value),
			visibility: visibility.value,
		}]));
	}

	private async discoverDirectory(
		root: DiscoveryRoot & { readonly kind: "directory" },
		options: DiscoveryOptions,
		selector: GlobSelector | undefined,
	): Promise<FsResult<Discovery>> {
		if (selector?.staticDirectoryPrefix !== undefined) {
			const visibility = await this.visibility.evaluate(root, "search");
			if (!visibility.ok) return visibility;
		}
		const start = await this.resolveTraversalStart(root, selector?.staticDirectoryPrefix);
		if (!start.ok) return start;
		if (start.value === undefined) return fsSuccess(eventStream([]));
		if ("event" in start.value) return fsSuccess(eventStream([start.value.event]));
		if (options.maxDepth !== undefined && start.value.depthOffset > options.maxDepth) {
			return fsSuccess(eventStream([{
				type: "skip",
				path: start.value.root.displayPath,
				reason: "depth-limit",
				kind: "directory",
			}]));
		}
		const opened = await this.traversal.walk(start.value.root, {
			intent: "search",
			explicitRoot: true,
			...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
			...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth - start.value.depthOffset }),
		});
		if (!opened.ok) return opened;
		return fsSuccess(this.mapTraversal(root, start.value.depthOffset, selector, opened.value));
	}

	private async discoverPathDirectory(
		root: DirectoryRef,
		options: DiscoveryOptions,
		selector: GlobSelector | undefined,
	): Promise<FsResult<PathDiscovery>> {
		if (selector?.staticDirectoryPrefix !== undefined) {
			const visibility = await this.visibility.evaluate(root, "search");
			if (!visibility.ok) return visibility;
		}
		const start = await this.resolveTraversalStart(root, selector?.staticDirectoryPrefix);
		if (!start.ok) return start;
		if (start.value === undefined) return fsSuccess(pathEventStream([]));
		if ("event" in start.value) return fsSuccess(pathEventStream([start.value.event]));
		if (options.maxDepth !== undefined && start.value.depthOffset > options.maxDepth) {
			return fsSuccess(pathEventStream([{
				type: "skip",
				path: start.value.root.displayPath,
				reason: "depth-limit",
				kind: "directory",
			}]));
		}
		const opened = await this.traversal.walkPaths(start.value.root, {
			intent: "search",
			explicitRoot: true,
			...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
			...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth - start.value.depthOffset }),
		});
		if (!opened.ok) return opened;
		return fsSuccess(this.mapPathTraversal(
			start.value.relativePrefix,
			start.value.depthOffset,
			selector,
			opened.value,
		));
	}

	private async resolveTraversalStart(
		root: DirectoryRef,
		prefix: string | undefined,
	): Promise<FsResult<TraversalStart | PrefixSkip | undefined>> {
		if (prefix === undefined) return fsSuccess({ root, depthOffset: 0, relativePrefix: "" });
		const segments = prefix.split("/");
		let current = root;
		for (const segment of segments) {
			const child = await this.namespace.bridge.resolveChild(current, segment);
			if (!child.ok) {
				if (child.error.code === "not-found" || child.error.code === "not-directory" || child.error.code === "not-file") {
					return fsSuccess(undefined);
				}
				return child;
			}
			if (child.value.ref.kind === "symlink") {
				return fsSuccess({ event: {
					type: "skip",
					path: child.value.ref.displayPath,
					reason: "symlink",
					kind: "symlink",
				} });
			}
			if (child.value.ref.kind !== "directory") return fsSuccess(undefined);
			current = child.value.ref;
		}
		return fsSuccess({ root: current, depthOffset: segments.length, relativePrefix: segments.join("/") });
	}

	private mapTraversal(
		originalRoot: DirectoryRef,
		depthOffset: number,
		selector: GlobSelector | undefined,
		traversal: Traversal,
	): Discovery {
		const paths = this.namespace.paths;
		return new NativeDiscovery(async function* (stopped): AsyncGenerator<DiscoveryEvent> {
			for await (const event of traversal) {
				if (stopped()) return;
				if (event.type !== "entry") {
					yield event;
					continue;
				}
				if (event.ref.kind !== "file" && event.ref.kind !== "directory") continue;
				const relativePath = paths.relative(originalRoot, event.ref);
				if (relativePath === undefined) {
					yield {
						type: "error",
						path: event.ref.displayPath,
						error: { code: "invalid-path", message: "Discovered path is outside its root.", path: event.ref.displayPath },
						kind: event.ref.kind,
					} satisfies DiscoveryEvent;
					continue;
				}
				if (selector !== undefined && !selector.matches(relativePath, event.ref.kind)) continue;
				yield discoveryEntry(event, event.ref, relativePath, depthOffset);
			}
		}, async () => await traversal.close());
	}

	private mapPathTraversal(
		relativePrefix: string,
		depthOffset: number,
		selector: GlobSelector | undefined,
		traversal: PathTraversal,
	): PathDiscovery {
		return new NativeDiscovery<PathDiscoveryEntryEvent>(async function* (stopped): AsyncGenerator<PathDiscoveryEvent> {
			for await (const event of traversal) {
				if (stopped()) return;
				if (event.type !== "entry") {
					yield event;
					continue;
				}
				if (event.ref.kind !== "file" && event.ref.kind !== "directory") continue;
				const relativePath = relativePrefix.length === 0
					? event.relativePath
					: `${relativePrefix}/${event.relativePath}`;
				if (selector !== undefined && !selector.matches(relativePath, event.ref.kind)) continue;
				yield pathDiscoveryEntry(event, event.ref, relativePath, depthOffset);
			}
		}, async () => await traversal.close());
	}
}

type DiscoveryStreamEvent<TEntry extends PathDiscoveryEntryEvent> =
	| TEntry
	| DiscoverySkipEvent
	| DiscoveryErrorEvent;

class NativeDiscovery<TEntry extends PathDiscoveryEntryEvent>
implements AsyncIterable<DiscoveryStreamEvent<TEntry>> {
	private stopped = false;
	private closing?: Promise<void>;

	constructor(
		private readonly events: (stopped: () => boolean) => AsyncIterable<DiscoveryStreamEvent<TEntry>>,
		private readonly closeSource: () => Promise<void>,
	) {}

	[Symbol.asyncIterator](): AsyncIterator<DiscoveryStreamEvent<TEntry>> {
		return this.iterate();
	}

	close(): Promise<void> {
		this.stopped = true;
		this.closing ??= this.closeSource();
		return this.closing;
	}

	private async *iterate(): AsyncGenerator<DiscoveryStreamEvent<TEntry>> {
		try {
			if (this.stopped) return;
			for await (const event of this.events(() => this.stopped)) {
				if (this.stopped) return;
				yield event;
			}
		} finally {
			await this.close();
		}
	}
}

function eventStream(events: readonly DiscoveryEvent[]): Discovery {
	return new NativeDiscovery<DiscoveryEntryEvent>(async function* (stopped) {
		for (const event of events) {
			if (stopped()) return;
			yield event;
		}
	}, async () => {});
}

function pathEventStream(events: readonly PathDiscoveryEvent[]): PathDiscovery {
	return new NativeDiscovery<PathDiscoveryEntryEvent>(async function* (stopped) {
		for (const event of events) {
			if (stopped()) return;
			yield event;
		}
	}, async () => {});
}

function discoveryEntry(
	event: Extract<TraversalEvent, { readonly type: "entry" }>,
	ref: DiscoveryEntryEvent["ref"],
	relativePath: string,
	depthOffset: number,
): DiscoveryEntryEvent {
	return {
		type: "entry",
		ref,
		relativePath,
		depth: event.depth + depthOffset,
		snapshot: toFileSnapshot(event.metadata),
		visibility: event.visibility,
	};
}

function pathDiscoveryEntry(
	event: Extract<PathTraversalEvent, { readonly type: "entry" }>,
	ref: PathDiscoveryEntryEvent["ref"],
	relativePath: string,
	depthOffset: number,
): PathDiscoveryEntryEvent {
	return {
		type: "entry",
		ref,
		relativePath,
		depth: event.depth + depthOffset,
		visibility: event.visibility,
	};
}

function compileGlob(input: string, rootPath: string): FsResult<GlobSelector> {
	const slashed = input.replaceAll("\\", "/");
	if (isAbsolutePath(slashed)) {
		return fsFailure({ code: "invalid-path", message: "Discovery glob must be relative to its root.", path: rootPath });
	}
	let pattern = slashed.replace(/\/{2,}/gu, "/");
	while (pattern.startsWith("./")) pattern = pattern.slice(2);
	if (pattern.length === 0 || pattern.split("/").some((segment) => segment === "..")) {
		return fsFailure({ code: "invalid-path", message: "Discovery glob must not escape its root.", path: rootPath });
	}
	try {
		const matcher = picomatch(pattern, { dot: true, nonegate: true });
		const matchBasename = !pattern.includes("/");
		const staticDirectoryPrefix = matchBasename ? undefined : extractStaticDirectoryPrefix(pattern);
		return fsSuccess({
			...(staticDirectoryPrefix === undefined ? {} : { staticDirectoryPrefix }),
			matches(relativePath, kind) {
				const target = matchBasename ? path.posix.basename(relativePath) : relativePath;
				return matcher(target) || (kind === "directory" && matcher(`${target}/`));
			},
		});
	} catch (error) {
		return fsFailure({
			code: "invalid-path",
			message: error instanceof Error ? error.message : "Discovery glob is invalid.",
			path: rootPath,
		});
	}
}

function extractStaticDirectoryPrefix(pattern: string): string | undefined {
	const scanned = picomatch.scan(pattern);
	const base = normalizeRelativePath(scanned.base);
	if (base.length === 0) return undefined;
	if (scanned.isGlob) return base;
	const separator = base.lastIndexOf("/");
	return separator <= 0 ? undefined : base.slice(0, separator);
}

function normalizeRelativePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function aborted(pathname: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Operation aborted.", path: pathname });
}
