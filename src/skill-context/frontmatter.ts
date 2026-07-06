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

interface RawFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: string;
}

/** 解析 V1 简单 frontmatter；只支持顶层 key: value，避免引入 YAML 依赖。 */
export function parseSkillFile(raw: string, fallbackName: string, maxBodyChars: number): ParsedSkillFile {
	const normalized = raw.replace(/\r\n?/g, "\n");
	const { fields, body } = splitFrontmatter(normalized);
	const name = fields.name ?? fallbackName;
	const description = fields.description;

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

function splitFrontmatter(text: string): { fields: RawFrontmatter; body: string } {
	if (!text.startsWith("---\n")) return { fields: {}, body: text.trim() };
	const end = text.indexOf("\n---", 4);
	if (end === -1) return { fields: {}, body: text.trim() };
	const afterFence = text.slice(end + 4);
	if (afterFence.length > 0 && afterFence[0] !== "\n") return { fields: {}, body: text.trim() };
	return {
		fields: parseFields(text.slice(4, end)),
		body: afterFence.trim(),
	};
}

function parseFields(text: string): RawFrontmatter {
	const fields: RawFrontmatter = {};
	for (const line of text.split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		const value = stripQuotes(line.slice(separator + 1).trim());
		if (key === "name" || key === "description" || key === "disable-model-invocation") {
			fields[key] = value;
		}
	}
	return fields;
}

function stripQuotes(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

function validateSkillName(name: string): void {
	if (name.length < 1 || name.length > 64) throw new SkillFrontmatterError("skill name must be 1-64 characters.");
	if (!/^[a-z0-9-]+$/.test(name)) throw new SkillFrontmatterError("skill name must match ^[a-z0-9-]+$.");
	if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
		throw new SkillFrontmatterError("skill name cannot start/end with '-' or contain '--'.");
	}
}

