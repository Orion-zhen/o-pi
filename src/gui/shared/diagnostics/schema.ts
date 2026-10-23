import { Type } from "typebox";
import { diagnosticKinds, diagnosticScopes } from "./diagnostics.ts";

const text = (maxLength: number) => Type.String({ maxLength });
const nullableText = (maxLength: number) => Type.Union([text(maxLength), Type.Null()]);
export const guiDiagnosticSchema = Type.Object({
	id: text(128), at: Type.Number(),
	kind: Type.Enum(Object.keys(diagnosticKinds) as (keyof typeof diagnosticKinds)[]),
	scope: Type.Enum(Object.keys(diagnosticScopes) as (keyof typeof diagnosticScopes)[]),
	message: text(4096), stack: text(16384), componentStack: text(8192),
	sessionId: nullableText(256), lastAction: nullableText(64), lastEvent: nullableText(64),
	deliveryId: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	running: Type.Union([Type.Boolean(), Type.Null()]), userAgent: text(1024),
}, { additionalProperties: false });
