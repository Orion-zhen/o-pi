import type { PathGuardBlock } from "../../safety/path-guard.js";
import { fail, type FailedResult } from "../shared/result.js";

export function protectedPathFailure(displayPath: string, block: PathGuardBlock): FailedResult {
	return fail("PROTECTED_PATH", block.message, {
		path: displayPath,
		details: {
			code: block.code,
			...(block.matched_rule !== undefined ? { matched_rule: block.matched_rule } : {}),
			...(block.matched_path !== undefined ? { matched_path: block.matched_path } : {}),
		},
	});
}
