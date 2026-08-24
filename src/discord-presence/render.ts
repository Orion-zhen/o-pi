import type {
	DiscordActivityPayload,
	DiscordPresenceConfig,
	PresenceActivity,
	PresenceProfileConfig,
	PresenceSession,
	PresenceTemplateValues,
} from "./types.js";

const MAX_TEXT_LENGTH = 128;
const TEMPLATE_PATTERN = /\{(project|model|session|file|language|executable|tool|label)\}/gu;
const ACTIVITY_LABELS: Record<PresenceActivity["kind"], string> = {
	idle: "Idle",
	thinking: "Thinking",
	reading: "Reading",
	editing: "Editing",
	writing: "Writing",
	searching: "Search",
	browsing: "Web",
	shell: "Terminal",
	other_tool: "Pi",
};

export function renderDiscordActivity(
	config: DiscordPresenceConfig,
	profile: PresenceProfileConfig,
	activity: PresenceActivity,
	session: PresenceSession,
): DiscordActivityPayload | undefined {
	const detailsTemplate = profile.details[activity.kind];
	if (detailsTemplate === undefined) return undefined;
	const values = templateValues(activity, session);
	const details = renderOptionalText(detailsTemplate, values);
	const state = renderOptionalText(profile.state, values);
	const largeImageKey = optionalAssetKey(config.assets.large.key);
	const largeImageText = renderOptionalText(config.assets.large.text, values);
	const smallImageKey = optionalAssetKey(
		(activity.languageKey === undefined ? undefined : config.assets.small.languages[activity.languageKey])
			|| config.assets.small.activities[activity.kind]
			|| config.assets.small.default,
	);
	const smallImageText = smallImageKey === undefined
		? undefined
		: renderOptionalText(config.assets.small.text, values);

	return {
		...(details === undefined ? {} : { details }),
		...(state === undefined ? {} : { state }),
		...(profile.show_elapsed ? { startTimestamp: session.startedAt } : {}),
		...(largeImageKey === undefined ? {} : { largeImageKey }),
		...(largeImageKey === undefined || largeImageText === undefined ? {} : { largeImageText }),
		...(smallImageKey === undefined ? {} : { smallImageKey }),
		...(smallImageText === undefined ? {} : { smallImageText }),
		instance: false,
	};
}

export function renderTemplate(template: string, values: PresenceTemplateValues): string {
	const rendered = template.replace(TEMPLATE_PATTERN, (_match, key: string) => values[key as keyof PresenceTemplateValues]);
	return truncate(Array.from(rendered.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim()), MAX_TEXT_LENGTH);
}

function templateValues(activity: PresenceActivity, session: PresenceSession): PresenceTemplateValues {
	return {
		project: session.project,
		model: session.model,
		session: session.session,
		file: activity.file ?? "",
		language: activity.language ?? "",
		executable: activity.executable ?? "command",
		tool: activity.tool,
		label: activity.language ?? ACTIVITY_LABELS[activity.kind],
	};
}

function renderOptionalText(template: string, values: PresenceTemplateValues): string | undefined {
	const rendered = renderTemplate(template, values);
	return Array.from(rendered).length >= 2 ? rendered : undefined;
}

function optionalAssetKey(value: string | undefined): string | undefined {
	const key = value?.trim();
	return key === undefined || key.length === 0 ? undefined : key;
}

function truncate(characters: string[], maximum: number): string {
	if (characters.length <= maximum) return characters.join("");
	return `${characters.slice(0, maximum - 1).join("")}…`;
}
