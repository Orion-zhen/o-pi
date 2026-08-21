import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DiscordPresenceConfigError,
	loadDiscordPresenceConfig,
} from "../../src/discord-presence/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { configuredProfile } from "./fixtures.js";

const temp = useTempDir("o-pi-discord-presence-config-");
preserveEnv(
	"PI_DISCORD_PRESENCE_CONFIG",
	"PI_DISCORD_PRESENCE_PROJECT_CONFIG",
	"PI_DISCORD_PRESENCE_PROJECT_ROOT",
);

describe("Discord presence 配置", () => {
	it("支持用户与项目稀疏覆盖", async () => {
		const userConfig = path.join(temp.path, "user.jsonc");
		const projectRoot = path.join(temp.path, "project");
		const projectConfig = path.join(projectRoot, ".pi", "configs", "discord-presence.jsonc");
		await mkdir(path.dirname(projectConfig), { recursive: true });
		await writeFile(userConfig, `{
			"enabled": true,
			"application_id": "123456789012345678",
			"profile": "standard",
			"profiles": { "standard": { "details": { "thinking": "Considering options" } } }
		}`);
		await writeFile(projectConfig, '{ "profile": "minimal" }');
		process.env["PI_DISCORD_PRESENCE_CONFIG"] = userConfig;

		const config = await loadDiscordPresenceConfig(projectRoot);

		expect(config).toMatchObject({
			enabled: true,
			application_id: "123456789012345678",
			profile: "minimal",
		});
		const standard = configuredProfile(config, "standard");
		expect(standard.details).toEqual({ thinking: "Considering options" });
	});

	it("支持选择用户定义的 profile", async () => {
		const configPath = path.join(temp.path, "custom-profile.jsonc");
		process.env["PI_DISCORD_PRESENCE_CONFIG"] = configPath;
		await writeFile(configPath, `{
			"profile": "focus",
			"profiles": {
				"focus": {
					"details": { "thinking": "憋个大的", "editing": "施工 {file}" },
					"state": "{project}",
					"show_elapsed": true
				}
			}
		}`);

		const config = await loadDiscordPresenceConfig(temp.path);

		expect(config.profile).toBe("focus");
		expect(configuredProfile(config, "focus")).toMatchObject({
			details: { thinking: "憋个大的", editing: "施工 {file}" },
			state: "{project}",
			show_elapsed: true,
		});
	});

	it("拒绝启用时缺少 Application ID、未知 profile 或未知模板占位符", async () => {
		const configPath = path.join(temp.path, "invalid.jsonc");
		process.env["PI_DISCORD_PRESENCE_CONFIG"] = configPath;
		await writeFile(configPath, '{ "enabled": true, "application_id": "" }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("application_id is required");

		await writeFile(configPath, '{ "update_interval_ms": 4999 }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("does not match schema");

		await writeFile(configPath, '{ "retry_interval_ms": 4999 }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("does not match schema");

		await writeFile(configPath, '{ "profile": "missing" }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("profile does not exist");

		await writeFile(configPath, '{ "profiles": { "minimal": { "state": "{secret}" } } }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toMatchObject({
			name: "DiscordPresenceConfigError",
			details: { path: "profiles.minimal.state", placeholder: "secret" },
		} satisfies Partial<DiscordPresenceConfigError>);
	});
});

