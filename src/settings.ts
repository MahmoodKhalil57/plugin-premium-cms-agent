/**
 * Plugin settings, kept as `settings:*` keys in the plugin's kv.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

export interface Settings {
	/** Offer the assistant in the toolbar at all. */
	enabled: boolean;
	/** The agent worker (a Cloudflare Worker running the Think agent). */
	agentUrl: string;
	/** Shared secret the plugin sends the worker (`AGENT_KEY` there). */
	agentKey: string;
	/** Workers AI model id, or a provider/model slug routed through AI Gateway. */
	model: string;
	reasoning: "low" | "medium" | "high";
	/** How long a chat session (and the token minted for it) lives, 1–24 hours. */
	sessionHours: number;
}

export const DEFAULTS: Settings = {
	enabled: true,
	agentUrl: "https://premium-cms-agent.premiumcms.workers.dev",
	agentKey: "",
	model: "@cf/zai-org/glm-5.3-flash",
	reasoning: "medium",
	sessionHours: 8,
};

const KEYS = Object.keys(DEFAULTS) as Array<keyof Settings>;
const HTTPS = /^https:\/\/[^\s/]+$/;

export async function readSettings(ctx: PluginContext): Promise<Settings> {
	const out: Settings = { ...DEFAULTS };
	for (const key of KEYS) {
		const v = await ctx.kv.get<unknown>(`settings:${key}`);
		if (v === null || v === undefined) continue;
		switch (key) {
			case "enabled":
				out.enabled = v === true || v === "true";
				break;
			case "sessionHours":
				out.sessionHours = clampHours(v);
				break;
			case "reasoning":
				if (v === "low" || v === "medium" || v === "high") out.reasoning = v;
				break;
			default:
				if (typeof v === "string") out[key] = v;
		}
	}
	return out;
}

function clampHours(v: unknown): number {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? Math.min(24, Math.max(1, n)) : DEFAULTS.sessionHours;
}

/** Persist the fields present in `input`; an empty agent key keeps the stored one. */
export async function saveSettings(ctx: PluginContext, input: Record<string, unknown>): Promise<void> {
	if ("enabled" in input) await ctx.kv.set("settings:enabled", input.enabled === true || input.enabled === "true");
	if (typeof input.agentUrl === "string") {
		const url = input.agentUrl.trim().replace(/\/+$/, "");
		if (!HTTPS.test(url)) throw new Error("Agent worker URL must be an https origin.");
		await ctx.kv.set("settings:agentUrl", url);
	}
	if (typeof input.agentKey === "string" && input.agentKey.trim()) await ctx.kv.set("settings:agentKey", input.agentKey.trim());
	if (typeof input.model === "string" && input.model.trim()) await ctx.kv.set("settings:model", input.model.trim());
	if (input.reasoning === "low" || input.reasoning === "medium" || input.reasoning === "high") {
		await ctx.kv.set("settings:reasoning", input.reasoning);
	}
	if ("sessionHours" in input) await ctx.kv.set("settings:sessionHours", clampHours(input.sessionHours));
}
