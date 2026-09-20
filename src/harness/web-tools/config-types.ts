export interface WebToolsConfig {
	network: {
		proxy: { enabled: boolean; http_proxy: string; https_proxy: string; socks5_proxy: string };
		fake_ip_ranges: string[];
	};
	websearch: {
		default_results: number;
		total_deadline_seconds: number;
		include_domains: string[];
		exclude_domains: string[];
		brave_api: {
			enabled: boolean;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
			extra_snippets: boolean;
		};
		exa_api: {
			enabled: boolean;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
			highlight_chars: number;
		};
		tavily: {
			enabled: boolean;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
		};
		duckduckgo_html: {
			enabled: boolean;
			timeout_seconds: number;
			user_agent: string;
			region: string;
			response_bytes: number;
			min_interval_seconds: number;
			blocked_cooldown_seconds: number;
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
