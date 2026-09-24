import { memo, useMemo } from "react";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/svg.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js";
import "@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js";
import "@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js";
import "@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const packages = ["base", "ams", "boldsymbol", "braket", "cancel", "centernot", "gensymb", "mathtools", "newcommand", "physics", "upgreek"];

function renderFormula(tex: string, display: boolean): string | undefined {
	const input = new TeX({ packages });
	const output = new SVG({ fontCache: "none", fontData: MathJaxTexFont });
	const document = mathjax.document("", { InputJax: input, OutputJax: output });
	try {
		const node = document.convert(tex, { display });
		const html = adaptor.outerHTML(node);
		return html.includes("data-mjx-error=") ? undefined : html;
	} catch {
		return undefined;
	}
}

export default memo(function MathFormula({ tex, source, display }: { tex: string; source: string; display: boolean }) {
	const html = useMemo(() => renderFormula(tex, display), [tex, display]);
	const className = display ? "math-formula math-display" : "math-formula";
	return html === undefined ? <span className={className}>{source}</span>
		: <span className={className} role="math" aria-label={tex} dangerouslySetInnerHTML={{ __html: html }} />;
});
