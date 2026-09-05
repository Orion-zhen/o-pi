import path from "node:path";
import picomatch from "picomatch";

import type {
	Discovery,
	DiscoveryEntryEvent,
	DiscoveryErrorEvent,
	DiscoveryOperations,
	DiscoveryOptions,
	DiscoveryRoot,
	DiscoverySkipEvent,
	PathDiscovery,
	PathDiscoveryEntryEvent,
	PathDiscoveryEvent,
} from "../contracts/discovery.js";
import { toFileSnapshot, type FileSnapshot, type MetadataOperations } from "../contracts/metadata.js";
import type { DirectoryRef, ExistingRef, SymlinkRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsError, type FsOperationContext, type FsResult } from "../contracts/result.js";
import type { VisibilityAnnotation, VisibilityOperations } from "../contracts/visibility.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { WorkspaceNamespaceKernel } from "../kernel/namespace.js";
import type { NativeDirectoryEntry, NativeFileSystem } from "../platform/node/native-filesystem.js";
import { DIRECTORY_ENTRY_CONCURRENCY } from "./concurrency.js";
import { compareLogicalPath } from "./path-order.js";
import { nativeIdentity } from "./ref.js";

interface GlobSelector {
	readonly staticDirectoryPrefix?: string;
	matches(relativePath: string, kind: "file" | "directory"): boolean;
}

interface DirectoryStart {
	readonly root: DirectoryRef;
	readonly depthOffset: number;
	readonly relativePrefix: string;
}

type DiscoveryMode = "paths" | "snapshots";
type DiscoverySource =
	| { readonly type: "events"; readonly events: readonly PathDiscoveryEvent[] }
	| {
		readonly type: "directory";
		readonly start: DirectoryStart;
		readonly entries: readonly NativeDirectoryEntry[];
		readonly bypassVisibility: boolean;
	};

type DiscoveryChild =
	| { readonly type: "path"; readonly ref: ExistingRef }
	| { readonly type: "snapshot"; readonly ref: ExistingRef; readonly snapshot: FileSnapshot };

type PreparedChild =
	| { readonly type: "error"; readonly error: FsError; readonly stage: "resolve" | "visibility" }
	| { readonly type: "symlink"; readonly ref: SymlinkRef }
	| {
		readonly type: "entry";
		readonly child: DiscoveryChild;
		readonly visibility: VisibilityAnnotation;
		readonly children?: FsResult<readonly NativeDirectoryEntry[]>;
	};

interface DiscoveryDependencies {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly visibility: VisibilityOperations;
	readonly context: FsOperationContext;
}

/** 范围准备与两种发现模式共用同一条遍历链，不再转换中间遍历事件。 */
export class WorkspaceDiscoveryService implements DiscoveryOperations {
	private cachedGlob?: { readonly input: string; readonly selector: GlobSelector };

	constructor(private readonly dependencies: DiscoveryDependencies, private readonly metadata: MetadataOperations) {}

	discover(root: DiscoveryRoot, options: DiscoveryOptions): Promise<FsResult<Discovery>> {
		return this.open(root, options, "snapshots");
	}

	discoverPaths(root: DirectoryRef, options: DiscoveryOptions): Promise<FsResult<PathDiscovery>> {
		return this.open(root, options, "paths");
	}

	private open(root: DiscoveryRoot, options: DiscoveryOptions, mode: "snapshots"): Promise<FsResult<Discovery>>;
	private open(root: DirectoryRef, options: DiscoveryOptions, mode: "paths"): Promise<FsResult<PathDiscovery>>;
	private async open(root: DiscoveryRoot, options: DiscoveryOptions, mode: DiscoveryMode): Promise<FsResult<PathDiscovery>> {
		if (this.dependencies.context.signal?.aborted === true) return aborted(root.displayPath);
		let selector: GlobSelector | undefined;
		if (options.glob !== undefined) {
			if (this.cachedGlob?.input === options.glob) selector = this.cachedGlob.selector;
			else {
				const compiled = compileGlob(options.glob, root.displayPath);
				if (!compiled.ok) return compiled;
				selector = compiled.value;
				this.cachedGlob = { input: options.glob, selector };
			}
		}
		const source = root.kind === "file"
			? await this.prepareFile(root, options, selector)
			: await this.prepareDirectory(root, options, selector);
		if (!source.ok) return source;
		return fsSuccess(new NativeDiscovery(this.dependencies, root, options, mode, selector, source.value));
	}

	private async prepareFile(
		root: DiscoveryRoot & { readonly kind: "file" },
		options: DiscoveryOptions,
		selector: GlobSelector | undefined,
	): Promise<FsResult<DiscoverySource>> {
		const identity = nativeIdentity(this.dependencies.namespace.bridge, root);
		if (!identity.ok) return identity;
		const relativePath = path.basename(identity.value.lexicalPath);
		if (selector !== undefined && !selector.matches(relativePath, "file")) return fsSuccess({ type: "events", events: [] });
		if (options.maxEntries === 0) {
			return fsSuccess({ type: "events", events: [{ type: "skip", path: root.displayPath, reason: "entry-limit", kind: "file" }] });
		}
		const visibility = await this.dependencies.visibility.evaluate(root, "search");
		if (!visibility.ok) return visibility;
		const metadata = await this.metadata.stat(root);
		if (!metadata.ok) return metadata;
		const event: DiscoveryEntryEvent = {
			type: "entry", ref: root, relativePath, depth: 0,
			snapshot: toFileSnapshot(metadata.value), visibility: visibility.value,
		};
		return fsSuccess({ type: "events", events: [event] });
	}

	private async prepareDirectory(
		root: DirectoryRef,
		options: DiscoveryOptions,
		selector: GlobSelector | undefined,
	): Promise<FsResult<DiscoverySource>> {
		if (selector?.staticDirectoryPrefix !== undefined) {
			const visibility = await this.dependencies.visibility.evaluate(root, "search");
			if (!visibility.ok) return visibility;
		}
		const start = await this.resolveStart(root, selector?.staticDirectoryPrefix);
		if (!start.ok) return start;
		if (start.value === undefined) return fsSuccess({ type: "events", events: [] });
		if ("type" in start.value) return fsSuccess({ type: "events", events: [start.value] });
		if (options.maxDepth !== undefined && start.value.depthOffset > options.maxDepth) {
			return fsSuccess({ type: "events", events: [{ type: "skip", path: start.value.root.displayPath, reason: "depth-limit", kind: "directory" }] });
		}
		const visibility = await this.dependencies.visibility.evaluate(start.value.root, "search");
		if (!visibility.ok) return visibility;
		const bypassVisibility = visibility.value.ignored;
		const entries = await readDirectory(this.dependencies, start.value.root, bypassVisibility);
		return entries.ok ? fsSuccess({ type: "directory", start: start.value, entries: entries.value, bypassVisibility }) : entries;
	}

	private async resolveStart(root: DirectoryRef, prefix: string | undefined): Promise<FsResult<DirectoryStart | DiscoverySkipEvent | undefined>> {
		if (prefix === undefined) return fsSuccess({ root, depthOffset: 0, relativePrefix: "" });
		const segments = prefix.split("/");
		let current = root;
		for (const segment of segments) {
			const child = await this.dependencies.namespace.bridge.resolveChild(current, segment);
			if (!child.ok) {
				if (child.error.code === "not-found" || child.error.code === "not-directory" || child.error.code === "not-file") return fsSuccess(undefined);
				return child;
			}
			if (child.value.ref.kind === "symlink") {
				return fsSuccess({ type: "skip", path: child.value.ref.displayPath, reason: "symlink", kind: "symlink" });
			}
			if (child.value.ref.kind !== "directory") return fsSuccess(undefined);
			current = child.value.ref;
		}
		return fsSuccess({ root: current, depthOffset: segments.length, relativePrefix: prefix });
	}
}

/** 每次发现只拥有一个单次流和扫描预算，关闭不会影响同一租约中的其他发现。 */
class NativeDiscovery implements PathDiscovery {
	private stopped = false;
	private scannedEntries = 0;

	constructor(
		private readonly dependencies: DiscoveryDependencies,
		private readonly root: DiscoveryRoot,
		private readonly options: DiscoveryOptions,
		private readonly mode: DiscoveryMode,
		private readonly selector: GlobSelector | undefined,
		private readonly source: DiscoverySource,
	) {}

	[Symbol.asyncIterator](): AsyncIterator<PathDiscoveryEvent> {
		return this.iterate();
	}

	async close(): Promise<void> {
		this.stopped = true;
	}

	private async *iterate(): AsyncGenerator<PathDiscoveryEvent> {
		try {
			if (this.stopped) return;
			if (this.dependencies.context.signal?.aborted === true) {
				yield abortedEvent(this.root.displayPath);
				return;
			}
			if (this.source.type === "events") {
				for (const event of this.source.events) {
					if (this.stopped) return;
					yield event;
				}
			} else {
				const { start, entries, bypassVisibility } = this.source;
				yield* this.walkDirectory(start.root, entries, start.depthOffset + 1, start.relativePrefix, bypassVisibility);
			}
		} finally {
			await this.close();
		}
	}

	private async *walkDirectory(
		directory: DirectoryRef,
		entries: readonly NativeDirectoryEntry[],
		depth: number,
		relativeDirectory: string,
		bypassVisibility: boolean,
	): AsyncGenerator<PathDiscoveryEvent> {
		if (this.options.maxDepth !== undefined && depth > this.options.maxDepth) {
			if (entries.length > 0) yield { type: "skip", path: directory.displayPath, reason: "depth-limit", kind: "directory" };
			return;
		}
		const sorted = [...entries].sort((left, right) => compareLogicalPath(left.name, right.name));
		for (let start = 0; start < sorted.length;) {
			if (this.stopped) return;
			if (this.dependencies.context.signal?.aborted === true) {
				this.stopped = true;
				yield abortedEvent(directory.displayPath);
				return;
			}
			const batchSize = this.options.maxEntries === undefined ? DIRECTORY_ENTRY_CONCURRENCY
				: Math.max(1, Math.min(DIRECTORY_ENTRY_CONCURRENCY, this.options.maxEntries - this.scannedEntries));
			const batch = await Promise.all(sorted.slice(start, start + batchSize).map(async (entry) => ({
				entry, prepared: await this.prepareChild(directory, entry, bypassVisibility),
			})));
			start += batchSize;
			for (const { entry, prepared } of batch) {
				if (this.stopped) return;
				if (isAborted(this.dependencies.context)) {
					this.stopped = true;
					yield abortedEvent(directory.displayPath);
					return;
				}
				if (prepared.type === "error" && prepared.stage === "resolve" && prepared.error.code === "blocked") {
					yield { type: "skip", path: prepared.error.path ?? entry.name, reason: "blocked", kind: entry.kind };
					continue;
				}
				// 受阻条目不计入扫描预算，glob 未命中的条目仍消耗预算。
				if (this.options.maxEntries !== undefined && this.scannedEntries >= this.options.maxEntries) {
					this.stopped = true;
					yield { type: "skip", path: directory.displayPath, reason: "entry-limit", kind: "directory" };
					return;
				}
				this.scannedEntries += 1;
				if (prepared.type === "error") {
					if (prepared.error.code === "aborted") this.stopped = true;
					yield { type: "error", path: prepared.error.path ?? entry.name, error: prepared.error,
						...(prepared.stage === "resolve" ? { kind: entry.kind } : {}) };
					continue;
				}
				if (prepared.type === "symlink") {
					yield { type: "skip", path: prepared.ref.displayPath, reason: "symlink", kind: "symlink" };
					continue;
				}
				const { child, visibility, children } = prepared;
				const ref = child.ref;
				const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
				if (visibility.ignored) {
					yield { type: "skip", path: ref.displayPath, reason: "ignored", kind: ref.kind };
					if (ref.kind !== "directory" || visibility.prune) continue;
				} else if (ref.kind === "file" || ref.kind === "directory") {
					const selectedPath = child.type === "snapshot" && this.root.kind === "directory"
						? this.dependencies.namespace.paths.relative(this.root, ref) : relativePath;
					if (selectedPath === undefined) {
						yield { type: "error", path: ref.displayPath, kind: ref.kind,
							error: { code: "invalid-path", message: "Discovered path is outside its root.", path: ref.displayPath } };
					} else if (this.selector === undefined || this.selector.matches(selectedPath, ref.kind)) {
						const event: PathDiscoveryEntryEvent = { type: "entry", ref, relativePath: selectedPath, depth, visibility };
						const selected: PathDiscoveryEntryEvent | DiscoveryEntryEvent = child.type === "snapshot"
							? { ...event, snapshot: child.snapshot } : event;
						yield selected;
					}
				}
				if (ref.kind !== "directory" || children === undefined) continue;
				if (!children.ok) {
					if (children.error.code === "aborted") this.stopped = true;
					yield { type: "error", path: ref.displayPath, error: children.error };
					continue;
				}
				if (!this.stopped) yield* this.walkDirectory(ref, children.value, depth + 1, relativePath, bypassVisibility);
			}
		}
	}

	private async prepareChild(directory: DirectoryRef, entry: NativeDirectoryEntry, bypassVisibility: boolean): Promise<PreparedChild> {
		const resolved = await this.resolveChild(directory, entry);
		if (!resolved.ok) return { type: "error", error: resolved.error, stage: "resolve" };
		const child = resolved.value;
		if (child.ref.kind === "symlink") return { type: "symlink", ref: child.ref };
		const visibility = bypassVisibility ? fsSuccess({ ignored: false, prune: false })
			: await this.dependencies.visibility.evaluate(child.ref, "search");
		if (!visibility.ok) return { type: "error", error: visibility.error, stage: "visibility" };
		if (child.ref.kind !== "directory" || (visibility.value.ignored && visibility.value.prune)) {
			return { type: "entry", child, visibility: visibility.value };
		}
		return { type: "entry", child, visibility: visibility.value,
			children: await readDirectory(this.dependencies, child.ref, bypassVisibility) };
	}

	private async resolveChild(directory: DirectoryRef, entry: NativeDirectoryEntry): Promise<FsResult<DiscoveryChild>> {
		const bridge = this.dependencies.namespace.bridge;
		if (this.mode === "paths" && (entry.kind === "file" || entry.kind === "directory")) {
			const projected = entry.kind === "file" ? bridge.projectListedChild(directory, entry.name, "file")
				: bridge.projectListedChild(directory, entry.name, "directory");
			return projected.ok ? fsSuccess({ type: "path", ref: projected.value }) : projected;
		}
		const resolved = await bridge.resolveChild(directory, entry.name);
		if (!resolved.ok) return resolved;
		return this.mode === "snapshots"
			? fsSuccess({ type: "snapshot", ref: resolved.value.ref, snapshot: toFileSnapshot(resolved.value.metadata) })
			: fsSuccess({ type: "path", ref: resolved.value.ref });
	}
}

async function readDirectory(
	dependencies: DiscoveryDependencies,
	directory: DirectoryRef,
	bypassVisibility: boolean,
): Promise<FsResult<readonly NativeDirectoryEntry[]>> {
	const identity = nativeIdentity(dependencies.namespace.bridge, directory);
	if (!identity.ok) return identity;
	try {
		const entries = await dependencies.native.readdir(identity.value.nativePath, dependencies.context);
		if (bypassVisibility) return fsSuccess(entries);
		const prepared = await dependencies.visibility.prepareDirectory(directory, entries);
		return prepared.ok ? fsSuccess(entries) : prepared;
	} catch (error) {
		return fsFailure(mapNativeError(error, directory.displayPath));
	}
}

function compileGlob(input: string, rootPath: string): FsResult<GlobSelector> {
	const slashed = input.replaceAll("\\", "/");
	if (slashed.startsWith("/") || /^[A-Za-z]:\//u.test(slashed)) {
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
		return fsFailure({ code: "invalid-path", message: error instanceof Error ? error.message : "Discovery glob is invalid.", path: rootPath });
	}
}

function extractStaticDirectoryPrefix(pattern: string): string | undefined {
	const scanned = picomatch.scan(pattern);
	const base = scanned.base.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
	if (base.length === 0) return undefined;
	if (scanned.isGlob) return base;
	const separator = base.lastIndexOf("/");
	return separator <= 0 ? undefined : base.slice(0, separator);
}

function isAborted(context: FsOperationContext): boolean {
	return context.signal?.aborted === true;
}

function aborted(pathname: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Operation aborted.", path: pathname });
}

function abortedEvent(pathname: string): DiscoveryErrorEvent {
	return { type: "error", path: pathname, error: { code: "aborted", message: "Operation aborted.", path: pathname } };
}
