import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { BashEnvironmentConfig, BashSessionMetadata, BashToolConfig } from "./types.js";

interface PythonVirtualEnvironment {
	root: string;
	bin: string;
}

export async function createExecutionEnvironment(cwd: string, session: BashSessionMetadata, config: BashToolConfig): Promise<NodeJS.ProcessEnv> {
	const virtualEnv = await resolvePythonVirtualEnvironment(cwd, config.python_venv_paths);
	const env = createBashEnvironment(session, config.environment);
	if (virtualEnv !== undefined) {
		const pathKey = environmentKey(env, "PATH");
		env[pathKey] = [virtualEnv.bin, env[pathKey]].filter(Boolean).join(path.delimiter);
		deleteEnvironmentVariable(env, "PYTHONHOME");
		deleteEnvironmentVariable(env, "VIRTUAL_ENV");
		deleteEnvironmentVariable(env, "PIP_REQUIRE_VIRTUALENV");
		setEnvironmentVariable(env, "VIRTUAL_ENV", virtualEnv.root);
		// 没有安装 pip 的 venv 也不能向后回退并修改全局环境。
		setEnvironmentVariable(env, "PIP_REQUIRE_VIRTUALENV", "1");
	}
	return env;
}

/** 并行检测配置的 Python 虚拟环境，并按路径顺序选择首个有效项。 */
async function resolvePythonVirtualEnvironment(
	cwd: string,
	configuredPaths: readonly string[],
): Promise<PythonVirtualEnvironment | undefined> {
	const scriptsDir = process.platform === "win32" ? "Scripts" : "bin";
	const interpreter = process.platform === "win32" ? "python.exe" : "python";
	const probes = configuredPaths.map(async (configuredPath): Promise<PythonVirtualEnvironment | undefined> => {
		const root = path.resolve(cwd, configuredPath);
		const bin = path.join(root, scriptsDir);
		try {
			const markerStat = await stat(path.join(root, "pyvenv.cfg"));
			if (!markerStat.isFile()) return undefined;
			const interpreterPath = path.join(bin, interpreter);
			const interpreterStat = await stat(interpreterPath);
			if (!interpreterStat.isFile()) return undefined;
			await access(interpreterPath, constants.X_OK);
			return { root, bin };
		} catch {
			return undefined;
		}
	});
	for (const probe of probes) {
		const candidate = await probe;
		if (candidate !== undefined) return candidate;
	}
	return undefined;
}

/** 按显式继承策略构造 shell 环境，并只暴露允许的当前会话 PI_* 元数据。 */
function createBashEnvironment(session: BashSessionMetadata, config: BashEnvironmentConfig): NodeJS.ProcessEnv {
	const flags = process.platform === "win32" ? "iu" : "u";
	const deniedNames = config.remove_name_regex.map((rule) => new RegExp(rule, flags));
	const env: NodeJS.ProcessEnv = {};
	if (config.inherit) {
		for (const [name, value] of Object.entries(process.env)) {
			if (!deniedNames.some((rule) => rule.test(name))) env[name] = value;
		}
	}
	const pathKey = environmentKey(env, "PATH");
	const currentPath = env[pathKey] ?? "";
	const managedBin = path.join(getAgentDir(), "bin");
	const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
	if (!pathEntries.some((entry) => samePath(entry, managedBin))) {
		env[pathKey] = [managedBin, currentPath].filter(Boolean).join(path.delimiter);
	}
	for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
		deleteEnvironmentVariable(env, name);
	}
	setEnvironmentVariable(env, "PI_SESSION_ID", session.sessionId);
	if (config.expose_pi_session_file) setEnvironmentVariable(env, "PI_SESSION_FILE", session.sessionFile);
	setEnvironmentVariable(env, "PI_PROVIDER", session.provider);
	setEnvironmentVariable(env, "PI_MODEL", session.model);
	setEnvironmentVariable(env, "PI_REASONING_LEVEL", session.reasoningLevel);
	return env;
}

function environmentKey(env: NodeJS.ProcessEnv, name: string): string {
	if (process.platform !== "win32") return name;
	return Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}

function deleteEnvironmentVariable(env: NodeJS.ProcessEnv, name: string): void {
	if (process.platform !== "win32") {
		delete env[name];
		return;
	}
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === name.toLowerCase()) delete env[key];
	}
}

function setEnvironmentVariable(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
	if (value !== undefined) env[environmentKey(env, name)] = value;
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
