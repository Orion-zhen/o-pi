/** 将宿主授权的逻辑路径根映射到真实目录。 */
export interface FilesystemMount {
	readonly logicalRoot: string;
	readonly nativeRoot: string;
}

/** 调用级逻辑挂载及不可通过普通路径绕过的真实根目录。 */
export interface FilesystemPathAccess {
	readonly mounts: readonly FilesystemMount[];
	readonly protectedRoots: readonly string[];
	readonly managedSchemes: readonly string[];
}
