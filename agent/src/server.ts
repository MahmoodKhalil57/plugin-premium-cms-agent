/**
 * premium-cms-agent — the site assistant behind the EmDash toolbar.
 *
 * One Think agent per chat session (`SiteAgent`, a Durable Object) with two
 * MCP servers and nothing else: the site's own MCP endpoint, reached with a
 * short-lived token the editor's browser minted (so every call is the
 * editor's own access), and the browser bridge (`BrowserBridge`), whose tools
 * run inside the editor's tab. No bash, no fetch tools, no scripts — one
 * bundled skill and MCP tools only.
 *
 * Sessions are opened by the site's plugin (`POST /session`, AGENT_KEY). The
 * browser only ever holds the session ticket it connects with, both for the
 * chat WebSocket (`/agents/site-agent/<session>?ticket=…`) and the bridge.
 */
import { skills, Think } from "@cloudflare/think";
import { getAgentByName, routeAgentRequest } from "agents";

import { BrowserBridge } from "./browser-bridge.js";
import { SITE_ASSISTANT_SKILL } from "./skill.js";

export { BrowserBridge };

export interface Env {
	AI: Ai;
	SiteAgent: DurableObjectNamespace<SiteAgent>;
	BrowserBridge: DurableObjectNamespace<BrowserBridge>;
	ASSETS: Fetcher;
	/** Shared secret the site plugin sends as `Authorization: Bearer …`. */
	AGENT_KEY: string;
	/** Default model; a session may name its own. */
	MODEL?: string;
}

export interface SessionConfig {
	sessionId: string;
	/** The browser's credential for this session (chat socket + bridge). */
	ticket: string;
	siteUrl: string;
	siteName: string;
	user: { id: string; name: string | null; email: string; role: number };
	/** The editor's short-lived API token: lives here and in the site MCP connection only. */
	token: string;
	expiresAt: string;
	pageUrl: string;
	model?: string;
	reasoning?: "low" | "medium" | "high";
	/** This worker's origin, for the bridge MCP URL. */
	origin: string;
}

const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Site tools the toolbar assistant never gets: destruction and administration stay in the admin. */
const FORBIDDEN = /permanent|schema_(create|update|delete|remove)|settings_(set|update|write|save)|token|user_(create|update|delete|invite)|role|polic|webhook|backup|restore|migrat/i;

export class SiteAgent extends Think<Env> {
	workspaceBash = false;
	fetchTools = false as const;
	includeMcpTools = true;
	waitForMcpConnections = { timeout: 30_000 };
	maxSteps = 60;
	sendReasoning = false;

	private config: SessionConfig | null = null;

	async onStart(): Promise<void> {
		this.config = (await this.ctx.storage.get<SessionConfig>("session")) ?? null;
	}

	getModel() {
		return this.config?.model || this.env.MODEL || DEFAULT_MODEL;
	}

	getSystemPrompt() {
		return "You are the site assistant of an EmDash site, chatting with a signed-in editor from the site's toolbar. Activate the site-assistant skill and follow it. You act only through the connected MCP tools; you cannot run code anywhere else.";
	}

	async getSkills() {
		return [
			skills.fromManifest({
				id: "premium-cms-agent",
				fingerprint: "site-assistant@1",
				skills: [SITE_ASSISTANT_SKILL],
			}),
		];
	}

	getSkillScriptRunner() {
		return null;
	}

	beforeToolCall(ctx: { toolName: string }) {
		if (FORBIDDEN.test(ctx.toolName)) {
			return {
				action: "block" as const,
				reason: `"${ctx.toolName}" is not available from the toolbar assistant — use the admin for that.`,
			};
		}
		return undefined;
	}

	/** Bind this object to a session and connect both MCP servers. Idempotent. */
	async init(config: SessionConfig): Promise<{ ok: true }> {
		this.config = config;
		await this.ctx.storage.put("session", config);
		const connected = new Set(
			Object.values(this.getMcpServers().servers ?? {}).map((s: { name?: string }) => s.name ?? ""),
		);
		if (!connected.has("site")) {
			await this.addMcpServer("site", `${config.siteUrl}/_emdash/api/mcp`, {
				transport: {
					type: "streamable-http",
					headers: { Authorization: `Bearer ${config.token}`, "X-EmDash-Request": "1" },
				},
			});
		}
		if (!connected.has("browser")) {
			await this.addMcpServer("browser", `${config.origin}/browser/${config.sessionId}/mcp`, {
				transport: { type: "streamable-http", headers: { Authorization: `Bearer ${config.ticket}` } },
			});
		}
		return { ok: true };
	}

	async verifyTicket(ticket: string): Promise<boolean> {
		const c = this.config ?? ((await this.ctx.storage.get<SessionConfig>("session")) ?? null);
		return !!c && ticket.length > 0 && c.ticket === ticket && Date.parse(c.expiresAt) > Date.now();
	}

	async end(): Promise<{ ok: true }> {
		await this.ctx.storage.delete("session");
		this.config = null;
		return { ok: true };
	}

	/** What the control plane may see: who the session is for and how its MCP servers are doing (no secrets). */
	async status(): Promise<Record<string, unknown>> {
		const c = this.config ?? ((await this.ctx.storage.get<SessionConfig>("session")) ?? null);
		const servers = Object.entries(this.getMcpServers().servers ?? {}).map(([id, s]) => {
			const server = s as { name?: string; state?: string; server_url?: string; tools?: unknown[] };
			return { id, name: server.name, state: server.state, url: server.server_url, tools: Array.isArray(server.tools) ? server.tools.length : undefined };
		});
		const tools = (this.getMcpServers().tools ?? []) as Array<{ name?: string; serverId?: string }>;
		return {
			session: c ? { sessionId: c.sessionId, siteUrl: c.siteUrl, user: c.user, expiresAt: c.expiresAt, model: this.getModel() } : null,
			servers,
			tools: tools.map((t) => t.name),
		};
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `/agents/site-agent/<session>` — the instance name is the session id. */
function sessionFromAgentPath(pathname: string): string {
	return pathname.split("/")[3] ?? "";
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true });
		if (url.pathname === "/toolbar.js" || url.pathname === "/toolbar.js.map") return env.ASSETS.fetch(request);

		// Chat: the agents SDK routes WebSocket + HTTP to the session's object; the ticket gates both.
		if (url.pathname.startsWith("/agents/")) {
			const gate = async (req: Request) => {
				const u = new URL(req.url);
				const ticket = u.searchParams.get("ticket") ?? "";
				const name = sessionFromAgentPath(u.pathname);
				if (!SESSION_ID.test(name) || !ticket) return json({ error: "invalid ticket" }, 401);
				const agent = await getAgentByName(env.SiteAgent, name);
				if (!(await agent.verifyTicket(ticket))) return json({ error: "invalid ticket" }, 401);
				return undefined;
			};
			const routed = await routeAgentRequest(request, env, { onBeforeConnect: gate, onBeforeRequest: gate });
			return routed ?? json({ error: "not found" }, 404);
		}

		// Browser bridge: the editor's socket and the agent's MCP endpoint.
		const bridge = url.pathname.match(/^\/browser\/([A-Za-z0-9_-]{8,64})\/(ws|mcp)$/);
		if (bridge) {
			return env.BrowserBridge.get(env.BrowserBridge.idFromName(bridge[1]!)).fetch(request);
		}

		// Control plane: the site plugin, with the shared key.
		const auth = request.headers.get("Authorization") ?? "";
		if (!env.AGENT_KEY || auth !== `Bearer ${env.AGENT_KEY}`) return json({ error: "unauthorized" }, 401);

		if (request.method === "POST" && url.pathname === "/session") {
			const body = (await request.json().catch(() => null)) as Partial<Omit<SessionConfig, "sessionId" | "ticket" | "origin">> | null;
			const user = body?.user;
			if (
				!body ||
				typeof body.siteUrl !== "string" ||
				!/^https:\/\//.test(body.siteUrl) ||
				typeof body.token !== "string" ||
				!/^ec_pat_/.test(body.token) ||
				typeof body.expiresAt !== "string" ||
				!Number.isFinite(Date.parse(body.expiresAt)) ||
				!user ||
				typeof user.id !== "string"
			) {
				return json({ error: "siteUrl (https), user, token and expiresAt are required" }, 400);
			}
			const sessionId = randomToken(16);
			const ticket = randomToken(32);
			const config: SessionConfig = {
				sessionId,
				ticket,
				siteUrl: body.siteUrl.replace(/\/+$/, ""),
				siteName: typeof body.siteName === "string" ? body.siteName : "",
				user: { id: user.id, name: user.name ?? null, email: user.email ?? "", role: Number(user.role ?? 0) },
				token: body.token,
				expiresAt: body.expiresAt,
				pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : "",
				model: typeof body.model === "string" && body.model ? body.model : undefined,
				reasoning: body.reasoning,
				origin: url.origin,
			};
			const bridgeInit = await env.BrowserBridge.get(env.BrowserBridge.idFromName(sessionId)).fetch(
				new Request(`${url.origin}/browser/${sessionId}/init`, {
					method: "POST",
					headers: { Authorization: `Bearer ${env.AGENT_KEY}`, "Content-Type": "application/json" },
					body: JSON.stringify({ ticket, expiresAt: config.expiresAt }),
				}),
			);
			if (!bridgeInit.ok) return json({ error: "could not prepare the browser bridge" }, 500);
			const agent = await getAgentByName(env.SiteAgent, sessionId);
			await agent.init(config);
			return json({ sessionId, ticket, expiresAt: config.expiresAt });
		}

		const ending = url.pathname.match(/^\/session\/([A-Za-z0-9_-]{8,64})$/);
		if (request.method === "GET" && ending) {
			const agent = await getAgentByName(env.SiteAgent, ending[1]!);
			return json(await agent.status());
		}
		if (request.method === "DELETE" && ending) {
			const sessionId = ending[1]!;
			await env.BrowserBridge.get(env.BrowserBridge.idFromName(sessionId)).fetch(
				new Request(`${url.origin}/browser/${sessionId}/end`, {
					method: "POST",
					headers: { Authorization: `Bearer ${env.AGENT_KEY}` },
				}),
			);
			const agent = await getAgentByName(env.SiteAgent, sessionId);
			await agent.end();
			return json({ ok: true });
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
