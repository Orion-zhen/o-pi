import { createRoot } from "react-dom/client";
import { installGlobalDiagnostics, reportDiagnostic } from "@/diagnostics/diagnostics.ts";
import "@/diagnostics/diagnostics.css";
import { applyThemeColor } from "@/ui/theme/apply.ts";
import { DEFAULT_THEME_COLOR } from "@/ui/theme/palette.ts";
import "@/ui/theme/theme.css";
import "@/app/style.css";
import "@/features/chat/composer/composer.css";
import "@/features/chat/transcript/transcript.css";
import "@/features/chat/tools/tools.css";
import "@/features/chat/tools/rich-tools.css";
import "@/ui/content/code.css";
import "@/app/motion.css";
import "@/ui/motion/motion-primitives.css";
import "@/app/layout.css";

installGlobalDiagnostics();
document.title = window.opi ? "opi-desktop" : "opi-web";
void import("@/app/app.tsx").then(({ App }) => {
	applyThemeColor(DEFAULT_THEME_COLOR);
	const root = document.getElementById("root");
	if (!root) throw new Error("Missing application root");
	createRoot(root, {
		onUncaughtError: (error, info) => { reportDiagnostic("react-root", "application", error, info.componentStack); },
	}).render(<App />);
}).catch((error: unknown) => { reportDiagnostic("startup", "application", error); });
