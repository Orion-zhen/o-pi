import { pathToFileURL } from "node:url";
import path from "node:path";

import type { ComponentIdentity, ResourceUri } from "./types.js";

export function fileResourceUri(canonicalPath: string): ResourceUri {
	return pathToFileURL(path.resolve(canonicalPath)).href;
}

export function toolResourceUri(component: ComponentIdentity): ResourceUri {
	return `tool://${encodeURIComponent(component.kind)}/${encodeURIComponent(component.displayName)}@${component.sourceDigest}`;
}

export function bashResourceUri(): ResourceUri {
	return "exec://shell/bash";
}

export function mcpToolResourceUri(server: string, tool: string, digest: string): ResourceUri {
	return `mcp://${encodeURIComponent(server)}/${encodeURIComponent(tool)}@${digest}`;
}

export function skillResourceUri(name: string, digest: string): ResourceUri {
	return `skill://${encodeURIComponent(name)}@${digest}`;
}

export function agentResourceUri(name: string): ResourceUri {
	return `agent://${encodeURIComponent(name)}`;
}
