import { NativeFileSystemError, type NativeFileSystem, type NativeMetadata, type NativeOpenFile } from "../../src/filesystem/platform/node/native-filesystem.js";
import { overrideNativeFileSystem } from "./fixtures.js";

export interface NativeOverrides {
	readonly tracker?: { opened: number; closed: number };
	readonly beforeOpen?: (path: string) => Promise<void>;
	readonly stat?: (metadata: NativeMetadata) => NativeMetadata;
	readonly lstat?: (path: string, metadata: NativeMetadata) => NativeMetadata | void;
	readonly readdir?: (path: string) => void;
	readonly closeError?: boolean;
	readonly readError?: boolean;
	readonly beforeRead?: () => void;
}

export function wrapNative(base: NativeFileSystem, overrides: NativeOverrides): NativeFileSystem {
	return overrideNativeFileSystem({
		async lstat(pathname, options) {
			const metadata = await base.lstat(pathname, options);
			return overrides.lstat?.(pathname, metadata) ?? metadata;
		},
		async readdir(pathname, options) {
			overrides.readdir?.(pathname);
			return await base.readdir(pathname, options);
		},
		async open(pathname, options) {
			await overrides.beforeOpen?.(pathname);
			const handle = await base.open(pathname, options);
			overrides.tracker && (overrides.tracker.opened += 1);
			return wrapHandle(handle, overrides);
		},
	}, base);
}

function wrapHandle(handle: NativeOpenFile, overrides: NativeOverrides): NativeOpenFile {
	return {
		metadata: overrides.stat?.(handle.metadata) ?? handle.metadata,
		async read(buffer, offset, length, position, options) {
			overrides.beforeRead?.();
			if (overrides.readError === true) throw new NativeFileSystemError("io-error", "read", "test");
			return await handle.read(buffer, offset, length, position, options);
		},
		async close() {
			overrides.tracker && (overrides.tracker.closed += 1);
			await handle.close();
			if (overrides.closeError === true) throw new NativeFileSystemError("io-error", "close", "test");
		},
	};
}
