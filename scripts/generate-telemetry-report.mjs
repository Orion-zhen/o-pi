import path from "node:path";

import { loadTypeScript } from "./benchmark/loader.mjs";

const options = parseOptions(process.argv.slice(2));
if (options.help) {
	process.stdout.write(`Usage: bun scripts/generate-telemetry-report.mjs [options]

  --input DIR       telemetry run JSONL directory
  --output DIR      report output directory
  --tool NAME       filter tool (repeatable)
  --commit HASH     filter Git commit (repeatable)
  --dirty BOOL      filter Git dirty state (true/false)
  --from ISO        inclusive call time lower bound
  --to ISO          inclusive call time upper bound
`);
	process.exit(0);
}

const { generateTelemetryReport } = await loadTypeScript("src/harness/telemetry-report/command.ts");
const result = await generateTelemetryReport({
	...(options.input === undefined ? {} : { inputDirectory: path.resolve(options.input) }),
	...(options.output === undefined ? {} : { outputDirectory: path.resolve(options.output) }),
	query: {
		...(options.tools.length === 0 ? {} : { tools: options.tools }),
		...(options.commits.length === 0 ? {} : { git_commits: options.commits }),
		...(options.dirty.length === 0 ? {} : { git_dirty: options.dirty.map(boolean) }),
		...(options.from === undefined ? {} : { from: iso(options.from, "--from") }),
		...(options.to === undefined ? {} : { to: iso(options.to, "--to") }),
	},
});

process.stdout.write(`${JSON.stringify({
	output_directory: result.output_directory,
	inventory: result.report.inventory,
	edit: result.report.edit,
	candidate_ranking: result.report.candidate_ranking,
	invalid_lines: result.report.metadata.invalid_lines,
}, null, 2)}\n`);

function parseOptions(args) {
	const options = { help: false, input: undefined, output: undefined, from: undefined, to: undefined, tools: [], commits: [], dirty: [] };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (["--input", "--output", "--from", "--to"].includes(argument)) options[argument.slice(2)] = required(args, ++index, argument);
		else if (argument === "--tool") options.tools.push(required(args, ++index, argument));
		else if (argument === "--commit") options.commits.push(required(args, ++index, argument));
		else if (argument === "--dirty") options.dirty.push(required(args, ++index, argument));
		else throw new Error(`unknown argument: ${argument}`);
	}
	return options;
}

function required(args, index, flag) {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function iso(value, flag) {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`${flag} requires an ISO timestamp`);
	return parsed.toISOString();
}

function boolean(value) {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error("--dirty requires true or false");
}
