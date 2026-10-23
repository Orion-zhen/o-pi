import { useId, type CSSProperties, type ReactNode } from "react";
import "./welcome-surface.css";

export function WelcomeSurface({ children }: { children: ReactNode }) {
	const refraction = useId();
	const style: CSSProperties & { "--welcome-refraction": string } = {
		"--welcome-refraction": `url("#${refraction}")`,
	};
	return <div className="welcome-surface">
		<svg className="welcome-refraction" aria-hidden="true" focusable="false">
			<defs>
				<filter id={refraction} x="-5%" y="-8%" width="110%" height="116%" colorInterpolationFilters="sRGB">
					<feTurbulence type="fractalNoise" baseFrequency="0.009 0.016" numOctaves={1} seed={8} result="liquid" />
					<feDisplacementMap in="SourceGraphic" in2="liquid" scale={0} xChannelSelector="R" yChannelSelector="G">
						<animate attributeName="scale" values="0;14;4;0" keyTimes="0;0.25;0.65;1"
							calcMode="spline" keySplines="0.3 0 0.7 1;0.2 0 0.2 1;0.2 0 0.2 1" begin="indefinite" dur="0.9s" fill="freeze" />
					</feDisplacementMap>
				</filter>
			</defs>
		</svg>
		<div className="welcome-emergence">
			<div className="welcome-content" style={style}>{children}</div>
		</div>
	</div>;
}
