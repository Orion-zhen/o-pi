import type { WebSearchProviderId } from "./core/types.ts";

export interface WebToolsConfig {
	network: {
		proxy: { enabled: boolean; http_proxy: string; https_proxy: string; socks5_proxy: string };
		fake_ip_ranges: string[];
	};
	websearch: {
		primary_providers: WebSearchProviderId[];
		auxiliary_providers: WebSearchProviderId[];
		default_results: number;
		total_deadline_seconds: number;
		include_domains: string[];
		exclude_domains: string[];
		brave_api: {
			enabled: boolean;
			max_results: number;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
			extra_snippets: boolean;
		};
		exa_api: {
			enabled: boolean;
			max_results: number;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
			highlight_chars: number;
		};
		exa_mcp: {
			enabled: boolean;
			max_results: number;
			endpoint: string;
			timeout_seconds: number;
			response_bytes: number;
			highlight_chars: number;
		};
		tavily: {
			enabled: boolean;
			max_results: number;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
		};
		tinyfish: {
			enabled: boolean;
			max_results: number;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
		};
		anysearch: {
			enabled: boolean;
			max_results: number;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
		};
	};
	webfetch: {
		timeout_seconds: number;
		max_redirects: number;
		user_agent: string;
		readability: { char_threshold: number };
		media: { mode: "auto" | "on" | "off"; response_bytes: number };
		limits: { response_bytes: number; default_output_chars: number; find_max_passages: number };
		cookies: {
			enabled: boolean;
			domains: string[];
			confirmation: "always" | "session" | "never";
		};
	};
}
