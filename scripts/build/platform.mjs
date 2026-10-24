export const supportedPlatforms = [
	"linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl",
	"windows-x64", "windows-arm64", "darwin-x64", "darwin-arm64",
];

export function resolvePlatform(name) {
	if (!supportedPlatforms.includes(name)) throw new Error(`不支持的目标平台: ${name}。可选: ${supportedPlatforms.join(", ")}`);
	const [system, arch, variant] = name.split("-");
	const os = system === "windows" ? "win32" : system;
	const libc = os === "linux" ? (variant === "musl" ? "musl" : "glibc") : undefined;
	return {
		name,
		os,
		arch,
		libc,
		bunTarget: `bun-${name}`,
		nativeSuffix: [os, arch, libc === "glibc" ? "gnu" : libc, ...(os === "win32" ? ["msvc"] : [])].filter(Boolean).join("-"),
	};
}

export function hostPlatform() {
	const system = process.platform === "win32" ? "windows" : process.platform;
	const musl = system === "linux" && !process.report.getReport().header.glibcVersionRuntime;
	return resolvePlatform(`${system}-${process.arch}${musl ? "-musl" : ""}`);
}
