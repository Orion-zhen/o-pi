import { createRequire } from "node:module";

interface PackageManifest {
	optionalDependencies?: Record<string, string>;
}

const require = createRequire(import.meta.url);
const packageManifest: unknown = require("../../package.json");
const treeSitterPackages = isPackageManifest(packageManifest) && packageManifest.optionalDependencies !== undefined
	? Object.keys(packageManifest.optionalDependencies).filter((packageName) => packageName === "web-tree-sitter" || packageName.startsWith("tree-sitter-"))
	: [];

export function optionalDependencyPath(packageName: string): string | undefined {
	try {
		return require.resolve(packageName);
	} catch {
		return undefined;
	}
}

export function treeSitterAvailable(packages: readonly string[] = treeSitterPackages): boolean {
	return packages.length > 0 && packages.every((packageName) => optionalDependencyPath(packageName) !== undefined);
}

export function treeSitterModulePaths(packages: readonly string[] = treeSitterPackages): string[] {
	return packages.flatMap((packageName) => {
		const modulePath = optionalDependencyPath(packageName);
		return modulePath === undefined ? [] : [modulePath];
	});
}

function isPackageManifest(value: unknown): value is PackageManifest {
	return typeof value === "object" && value !== null && ("optionalDependencies" in value === false || isStringRecord(value.optionalDependencies));
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return typeof value === "object" && value !== null && Object.values(value).every((entry) => typeof entry === "string");
}
