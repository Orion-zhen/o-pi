import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rpcDialogSmokeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rpc-dialog-smoke", {
		description: "Exercise the RPC extension UI roundtrip.",
		handler: async (_args, ctx) => {
			const confirmed = await ctx.ui.confirm("RPC smoke", "Confirm dialog roundtrip.");
			ctx.ui.notify(`rpc-dialog-smoke:${confirmed ? "confirmed" : "denied"}`, "info");
		},
	});
}
