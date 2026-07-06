import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface ParsedSkillFile {
	name: string;
	description: string;
	body: string;
}

export class SkillFrontmatterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillFrontmatterError";
	}
}

/** 复用 Pi 官方 frontmatter 解析，随后按本扩展的 selected context 约束做校验。 */
export function parseSkillFile(raw: string, fallbackName: string, maxBodyChars: number): ParsedSkillFile {
	const { frontmatter, body } = parseSkillFrontmatter(raw);
	const name = stringField(frontmatter, "name") ?? fallbackName;
	const description = stringField(frontmatter, "description");

	validateSkillName(name);
	if (description === undefined || description.trim().length === 0) {
		throw new SkillFrontmatterError("skill description is required.");
	}
	if (description.length > 1024) {
		throw new SkillFrontmatterError("skill description must be 1-1024 characters.");
	}
	if (body.length > maxBodyChars) {
		throw new SkillFrontmatterError("SKILL.md body exceeds max_body_chars; increase config or split large references.");
	}

	return { name, description, body };
}

function parseSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	try {
		const parsed = parseFrontmatter(raw);
		return { frontmatter: parsed.frontmatter, body: parsed.body.trim() };
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid frontmatter";
		throw new SkillFrontmatterError(`failed to parse skill frontmatter: ${message}`);
	}
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

function validateSkillName(name: string): void {
	if (name.length < 1 || name.length > 64) throw new SkillFrontmatterError("skill name must be 1-64 characters.");
	if (!/^[a-z0-9-]+$/.test(name)) throw new SkillFrontmatterError("skill name must match ^[a-z0-9-]+$.");
	if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
		throw new SkillFrontmatterError("skill name cannot start/end with '-' or contain '--'.");
	}
}
