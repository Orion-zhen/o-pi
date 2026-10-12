import { Component, type ErrorInfo, type ReactNode } from "react";
import { diagnosticScopes, errorSummary, type GuiDiagnostic } from "../../diagnostics.ts";
import { reportDiagnostic } from "./diagnostics.ts";

export class RegionBoundary extends Component<{
	scope: Exclude<GuiDiagnostic["scope"], "application">;
	children: ReactNode;
	inline?: boolean;
	onFailure?: () => void;
}, { failed: boolean; diagnostic: GuiDiagnostic | null }> {
	state: { failed: boolean; diagnostic: GuiDiagnostic | null } = { failed: false, diagnostic: null };
	static getDerivedStateFromError() { return { failed: true }; }
	componentDidCatch(error: unknown, info: ErrorInfo) {
		const diagnostic = reportDiagnostic("region", this.props.scope, error, info.componentStack);
		this.setState({ diagnostic });
		this.props.onFailure?.();
	}
	render() {
		if (!this.state.failed) return this.props.children;
		if (this.props.inline === false) return null;
		return <section className="diagnostic-region" role="alert">
			<strong>{diagnosticScopes[this.props.scope]}显示失败</strong>
			<p>{this.state.diagnostic && errorSummary(this.state.diagnostic.message)}</p>
			<p>诊断编号: {this.state.diagnostic?.id}。详情见页面异常诊断。</p>
		</section>;
	}
}
