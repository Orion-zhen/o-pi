import { bool, int, nullable, num, obj, oneOf, str } from "@earendil-works/pi-schema";
import { diagnosticKinds, diagnosticScopes } from "./diagnostics.ts";

const text = (maxLength: number) => str({ maxLength });
const nullableText = (maxLength: number) => nullable(text(maxLength));
export const guiDiagnosticSchema = obj({
	id: text(128), at: num(),
	kind: oneOf(Object.keys(diagnosticKinds) as (keyof typeof diagnosticKinds)[]),
	scope: oneOf(Object.keys(diagnosticScopes) as (keyof typeof diagnosticScopes)[]),
	message: text(4096), stack: text(16384), componentStack: text(8192),
	sessionId: nullableText(256), lastAction: nullableText(64), lastEvent: nullableText(64),
	deliveryId: nullable(int({ minimum: 0 })),
	running: nullable(bool()), userAgent: text(1024),
});
