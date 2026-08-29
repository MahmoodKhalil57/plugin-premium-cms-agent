/**
 * Site Agent — a chat assistant that lives in the EmDash toolbar.
 *
 *   surface   The toolbar's "Agent" button (this plugin's `toolbar` route
 *             describes it; core renders it) loads the worker's toolbar.js,
 *             which opens a chat panel on the page the editor is looking at.
 *   session   The panel mints a short-lived token for the signed-in editor
 *             (core `POST /_emdash/api/auth/session-tokens`, session-only)
 *             and asks this plugin's `session` route to open a chat session
 *             on the agent worker. The worker keeps the token; the browser
 *             only ever holds a session ticket.
 *   agent     A Cloudflare Worker running a Think agent with two MCP
 *             servers: the site's own MCP endpoint (acting as the editor,
 *             within their permissions) and a browser bridge — an MCP server
 *             whose tools run inside the editor's tab (screenshots, DOM and
 *             style snapshots, console, clicks, evaluate).
 *   scope     Every route here is session-only: a request authenticated by an
 *             API token is refused, and the plugin exposes no MCP tools, so
 *             the assistant cannot be reached from another agent.
 *   storage   `sessions` — one row per chat session (who, when, which token).
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

import { DEFAULTS, readSettings, saveSettings, type Settings } from "./settings.js";

const PLUGIN_ID = "premium-cms-agent";
const SESSION_ROUTE = `/_emdash/api/plugins/${PLUGIN_ID}/session`;
const END_ROUTE = `/_emdash/api/plugins/${PLUGIN_ID}/session/end`;
/** Same threshold as the toolbar: authors and above. */
const MIN_ROLE = 30;
const TOKEN_SHAPE = /^ec_pat_[A-Za-z0-9_-]{20,}$/;

// ── Helpers ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function now(): string {
	return new Date().toISOString();
}

/** The caller core binds to a private route (`ctx.user`), with how it authenticated. */
interface Caller {
	id: string;
	email: string;
	name: string | null;
	role: number;
	tokenAuth?: boolean;
}

interface RouteCtx {
	input?: unknown;
	user?: Caller;
}

/**
 * The assistant is a browser surface: only a signed-in editor's session may
 * call these routes. A token-authenticated request — even the assistant's own
 * token — is refused, which is what keeps the agent from reaching itself.
 */
function sessionOnly(routeCtx: RouteCtx): { ok: true; user: Caller } | { ok: false; error: string } {
	const user = routeCtx.user;
	if (!user) return { ok: false, error: "Sign in to use the site agent." };
	if (user.tokenAuth) {
		return { ok: false, error: "The site agent is only available from the EmDash toolbar in a signed-in browser session." };
	}
	if (user.role < MIN_ROLE) return { ok: false, error: "The site agent is available to authors and above." };
	return { ok: true, user };
}

async function ready(ctx: PluginContext): Promise<{ ok: true; settings: Settings } | { ok: false; error: string }> {
	const settings = await readSettings(ctx);
	if (!settings.enabled) return { ok: false, error: "The site agent is turned off in its settings." };
	if (!settings.agentKey) return { ok: false, error: "The agent key is not set in the plugin settings." };
	return { ok: true, settings };
}

interface Session {
	id: string;
	userId: string;
	userName: string;
	tokenId: string;
	status: "open" | "closed";
	pageUrl: string;
	expiresAt: string;
	startedAt: string;
	updatedAt: string;
}

function isSession(v: unknown): v is Session {
	return isRecord(v) && typeof v.id === "string" && typeof v.userId === "string";
}

async function worker(
	ctx: PluginContext,
	settings: Settings,
	method: "POST" | "DELETE",
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
	const res = await ctx.http!.fetch(`${settings.agentUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${settings.agentKey}`,
			"Content-Type": "application/json",
			"User-Agent": "premium-cms-agent-plugin/1.0",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	let json: Record<string, unknown> = {};
	try {
		json = (await res.json()) as Record<string, unknown>;
	} catch {
		json = {};
	}
	return { ok: res.ok, status: res.status, json };
}

// ── Plugin ───────────────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			for (const [k, v] of Object.entries(DEFAULTS)) {
				if (k === "agentKey") continue;
				if ((await ctx.kv.get(`settings:${k}`)) === null) await ctx.kv.set(`settings:${k}`, v);
			}
			ctx.log.info("Site agent installed");
		},
	},

	routes: {
		/**
		 * Describes the toolbar button (core's `/_emdash/api/toolbar/extensions`
		 * collects it). The script is the worker's toolbar.js; `config` tells it
		 * which routes to call for a session.
		 */
		toolbar: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				const r = await ready(ctx);
				if (!r.ok) return { success: false, error: r.error };
				return {
					label: "Agent",
					script: `${r.settings.agentUrl}/toolbar.js`,
					config: {
						session: SESSION_ROUTE,
						end: END_ROUTE,
						purpose: PLUGIN_ID,
						sessionSeconds: r.settings.sessionHours * 3600,
					},
				};
			},
		},

		/**
		 * Open a chat session for the signed-in editor. The browser passes the
		 * session token it minted (core, session-only); it goes to the worker
		 * and nowhere else. Returns the ticket the browser connects with.
		 */
		session: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				const r = await ready(ctx);
				if (!r.ok) return { success: false, error: r.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const pageUrl = typeof input.pageUrl === "string" ? input.pageUrl.slice(0, 500) : "";
				const { user } = who;
				// A new chat next to an existing one: the worker reuses that chat's token.
				const parentId = typeof input.parent === "string" ? input.parent : "";
				const parent = parentId ? await ctx.storage.sessions!.get(parentId) : null;
				let token = typeof input.token === "string" ? input.token : "";
				let tokenId = typeof input.tokenId === "string" ? input.tokenId : "";
				let expiresAt = typeof input.expiresAt === "string" ? input.expiresAt : "";
				if (parentId) {
					if (!isSession(parent) || parent.userId !== user.id || parent.status !== "open") {
						return { success: false, error: "Unknown parent chat." };
					}
					tokenId = parent.tokenId;
					expiresAt = parent.expiresAt;
					token = "";
				} else if (!TOKEN_SHAPE.test(token) || !tokenId || !Number.isFinite(Date.parse(expiresAt))) {
					return { success: false, error: "A session token (token, tokenId, expiresAt) is required." };
				}
				const res = await worker(ctx, r.settings, "POST", "/session", {
					siteUrl: ctx.site.url,
					siteName: ctx.site.name,
					user: { id: user.id, name: user.name, email: user.email, role: user.role },
					...(parentId ? { parent: parentId } : { token, tokenId, expiresAt }),
					pageUrl,
					model: r.settings.model,
					reasoning: r.settings.reasoning,
				});
				if (!res.ok || typeof res.json.sessionId !== "string" || typeof res.json.ticket !== "string") {
					return { success: false, error: `agent ${res.status}: ${String(res.json.error ?? "could not open a session")}` };
				}
				const session: Session = {
					id: res.json.sessionId,
					userId: user.id,
					userName: user.name || user.email,
					tokenId,
					status: "open",
					pageUrl,
					expiresAt,
					startedAt: now(),
					updatedAt: now(),
				};
				await ctx.storage.sessions!.put(session.id, session);
				return { success: true, sessionId: session.id, ticket: res.json.ticket, host: r.settings.agentUrl, expiresAt };
			},
		},

		/** Close a session on the worker. The browser revokes the token itself (core, session-only). */
		"session/end": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const id = typeof input.sessionId === "string" ? input.sessionId : "";
				const row = id ? await ctx.storage.sessions!.get(id) : null;
				if (!isSession(row) || row.userId !== who.user.id) return { success: false, error: "Unknown session." };
				const settings = await readSettings(ctx);
				if (settings.agentKey) await worker(ctx, settings, "DELETE", `/session/${encodeURIComponent(id)}`).catch(() => undefined);
				await ctx.storage.sessions!.put(id, { ...row, status: "closed", updatedAt: now() });
				return { success: true, tokenId: row.tokenId };
			},
		},

		settings: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				const s = await readSettings(ctx);
				return { success: true, settings: { ...s, agentKey: s.agentKey ? "set" : "" } };
			},
		},

		"settings/save": {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				try {
					await saveSettings(ctx, isRecord(routeCtx.input) ? routeCtx.input : {});
				} catch (error) {
					return { success: false, error: String(error instanceof Error ? error.message : error) };
				}
				const s = await readSettings(ctx);
				return { success: true, settings: { ...s, agentKey: s.agentKey ? "set" : "" } };
			},
		},

		admin: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { blocks: [{ type: "banner", variant: "alert", description: who.error }] };
				const i = routeCtx.input as { type: string; action_id?: string; values?: Record<string, unknown> };
				if (i.type === "form_submit" && i.action_id === "save_settings") {
					try {
						await saveSettings(ctx, i.values ?? {});
					} catch (error) {
						return buildPage(ctx, String(error instanceof Error ? error.message : error));
					}
					return buildPage(ctx, "Settings saved.");
				}
				return buildPage(ctx);
			},
		},
	},
};

export default plugin;

// ── Admin page ───────────────────────────────────────────────────────────

async function buildPage(ctx: PluginContext, notice?: string) {
	const settings = await readSettings(ctx);
	const blocks: unknown[] = [{ type: "header", text: "Site Agent" }];
	if (notice) blocks.push({ type: "banner", description: notice });
	blocks.push({
		type: "context",
		text: "Editors open the assistant from the EmDash toolbar on the site (the Agent button). It chats through a Cloudflare Worker that reaches the site's MCP endpoint as the editor and the editor's own browser. It is not reachable from API tokens or other MCP clients.",
	});
	if (!settings.agentKey) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Agent key missing",
			description: "Paste the agent worker's key below. The toolbar shows no Agent button until it is set.",
		});
	}

	const sessions = (await ctx.storage.sessions!.query({ orderBy: { updatedAt: "desc" }, limit: 30 })).items
		.map((i) => i.data)
		.filter(isSession);
	blocks.push({
		type: "table",
		block_id: "sessions",
		page_action_id: "sessions_page",
		empty_text: "No chat sessions yet.",
		columns: [
			{ key: "user", label: "Editor", format: "text" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "page", label: "Opened on", format: "link" },
			{ key: "started", label: "Started", format: "relative_time" },
			{ key: "expires", label: "Token expires", format: "relative_time" },
		],
		rows: sessions.map((s) => ({ user: s.userName, status: s.status, page: s.pageUrl || "-", started: s.startedAt, expires: s.expiresAt })),
	});

	blocks.push({ type: "divider" });
	blocks.push({
		type: "form",
		block_id: "settings",
		fields: [
			{ type: "toggle", action_id: "enabled", label: "Offer the assistant in the toolbar", initial_value: settings.enabled },
			{ type: "text_input", action_id: "agentUrl", label: "Agent worker URL", initial_value: settings.agentUrl },
			{ type: "secret_input", action_id: "agentKey", label: settings.agentKey ? "Agent key (set — leave blank to keep)" : "Agent key" },
			{ type: "text_input", action_id: "model", label: "Model", initial_value: settings.model },
			{
				type: "select",
				action_id: "reasoning",
				label: "Reasoning effort",
				options: [
					{ label: "High (slow, thorough)", value: "high" },
					{ label: "Medium", value: "medium" },
					{ label: "Low", value: "low" },
				],
				initial_value: settings.reasoning,
			},
			{ type: "number_input", action_id: "sessionHours", label: "Session length (hours)", initial_value: settings.sessionHours, min: 1, max: 24 },
		],
		submit: { label: "Save settings", action_id: "save_settings" },
	});
	return { blocks };
}
