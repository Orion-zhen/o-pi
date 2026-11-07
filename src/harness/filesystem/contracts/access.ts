/** 将宿主授权的逻辑路径根映射到真实目录。 */
export interface FilesystemMount {
	readonly logicalRoot: string;
	readonly nativeRoot: string;
}

/** 调用级逻辑挂载及受管理的 URI 协议。 */
export interface FilesystemPathAccess {
	readonly mounts: readonly FilesystemMount[];
	readonly managedSchemes: readonly string[];
}
