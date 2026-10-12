import { createRoot } from "react-dom/client";
import { installGlobalDiagnostics, reportDiagnostic } from "./runtime/diagnostics.ts";
import "./runtime/diagnostics.css";
import { applyThemeColor } from "./preferences/apply.ts";
import { DEFAULT_THEME_COLOR } from "./preferences/palette.ts";
import "./preferences/theme.css";
import "./app/style.css";
import "./composer/composer.css";
import "./transcript/transcript.css";
import "./tools/tools.css";
import "./tools/rich-tools.css";
import "./content/code.css";
import "./app/motion.css";
import "./app/layout.css";

installGlobalDiagnostics();
document.title = window.opi ? "opi-desktop" : "opi-web";
void import("./app/app.tsx").then(({ App }) => {
	applyThemeColor(DEFAULT_THEME_COLOR);
	const root = document.getElementById("root");
	if (!root) throw new Error("Missing application root");
	createRoot(root, {
		onUncaughtError: (error, info) => { reportDiagnostic("react-root", "application", error, info.componentStack); },
	}).render(<App />);
}).catch((error: unknown) => { reportDiagnostic("startup", "application", error); });
