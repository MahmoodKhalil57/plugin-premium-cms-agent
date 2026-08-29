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
	/** Skills the site attaches to this chat (chosen by the plugin for the editor's role). */
	skills?: SiteSkill[];
	/** This worker's origin, for the bridge MCP URL. */
	origin: string;
}

/** A skill authored on the site's admin page: the same shape as a bundled skill. */
export interface SiteSkill {
	name: string;
	description: string;
	body: string;
}

const MAX_SITE_SKILLS = 30;
const MAX_SKILL_BODY = 24_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Keep only well-formed skills; names must be slugs and unique (the bundled skill's name is reserved). */
export function siteSkills(raw: unknown): SiteSkill[] {
	if (!Array.isArray(raw)) return [];
	const out: SiteSkill[] = [];
	const seen = new Set<string>([SITE_ASSISTANT_SKILL.name]);
	for (const item of raw) {
		if (out.length >= MAX_SITE_SKILLS || !item || typeof item !== "object") continue;
		const s = item as { name?: unknown; description?: unknown; body?: unknown };
		const name = typeof s.name === "string" ? s.name.trim().toLowerCase() : "";
		const description = typeof s.description === "string" ? s.description.trim() : "";
		const body = typeof s.body === "string" ? s.body.trim() : "";
		if (!SKILL_NAME.test(name) || seen.has(name) || !description || !body) continue;
		seen.add(name);
		out.push({ name, description: description.slice(0, 500), body: body.slice(0, MAX_SKILL_BODY) });
	}
	return out;
}

/** A short stable fingerprint of the skill set, so Think can tell one set from another. */
function skillsFingerprint(list: SiteSkill[]): string {
	let h = 5381;
	const text = JSON.stringify(list);
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return `site-skills@${(h >>> 0).toString(36)}-${list.length}`;
}

const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

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
		return "You are the site assistant of an EmDash site, chatting with a signed-in editor from the site's toolbar. Activate the site-assistant skill and follow it. You act through the connected MCP tools as that editor — content, media, schema, settings and the GitHub coding agent are all reachable that way; you cannot run code anywhere else.";
	}

	async getSkills() {
		const own = this.config?.skills ?? ((await this.ctx.storage.get<SessionConfig>("session"))?.skills ?? []);
		return [
			skills.fromManifest({
				id: "premium-cms-agent",
				fingerprint: "site-assistant@1",
				skills: [SITE_ASSISTANT_SKILL],
			}),
			...(own.length
				? [
						skills.fromManifest({
							id: "site-skills",
							fingerprint: skillsFingerprint(own),
							skills: own,
						}),
					]
				: []),
		];
	}

	getSkillScriptRunner() {
		return null;
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

	/** What a child chat inherits (the token stays on the worker); null once the session ended. */
	async exportForChild(): Promise<Pick<SessionConfig, "siteUrl" | "siteName" | "user" | "token" | "expiresAt" | "model" | "reasoning"> | null> {
		const c = this.config ?? ((await this.ctx.storage.get<SessionConfig>("session")) ?? null);
		if (!c || Date.parse(c.expiresAt) <= Date.now()) return null;
		const { siteUrl, siteName, user, token, expiresAt, model, reasoning } = c;
		return { siteUrl, siteName, user, token, expiresAt, model, reasoning };
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

	/**
	 * Operator smoke test: one turn without a browser client. Submits a user
	 * message and waits for the run to finish (up to ~2 minutes), returning the
	 * assistant's final text. Chat clients never use this path.
	 */
	async say(text: string): Promise<{ status: string; answer: string | null; steps: number }> {
		const res = await this.submitMessages([{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }]);
		const terminal = new Set(["completed", "error", "aborted", "skipped", "unknown"]);
		let status = "queued";
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			const s = await this.inspectSubmission(res.submissionId);
			status = s?.status ?? "unknown";
			if (terminal.has(status)) break;
		}
		const last = [...this.messages].reverse().find((m) => m.role === "assistant");
		const parts = (last?.parts ?? []) as Array<{ type: string; text?: string }>;
		return {
			status,
			answer: parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("").trim() || null,
			steps: parts.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool").length,
		};
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

/** The chat client runs on the site's origin, so agent-route answers carry CORS headers (tickets, not cookies, gate them). */
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
	"Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, cors = false): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cors ? CORS : {}) },
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
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			const gate = async (req: Request) => {
				const u = new URL(req.url);
				const ticket = u.searchParams.get("ticket") ?? "";
				const name = sessionFromAgentPath(u.pathname);
				if (!SESSION_ID.test(name) || !ticket) return json({ error: "invalid ticket" }, 401, true);
				const agent = await getAgentByName(env.SiteAgent, name);
				if (!(await agent.verifyTicket(ticket))) return json({ error: "invalid ticket" }, 401, true);
				return undefined;
			};
			const routed = await routeAgentRequest(request, env, { cors: true, onBeforeConnect: gate, onBeforeRequest: gate });
			return routed ?? json({ error: "not found" }, 404, true);
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
			const body = (await request.json().catch(() => null)) as
				| (Partial<Omit<SessionConfig, "sessionId" | "ticket" | "origin">> & { parent?: unknown })
				| null;
			const user = body?.user;
			if (!body || !user || typeof user.id !== "string") return json({ error: "user is required" }, 400);

			// A child chat: reuse the parent's token and site (the plugin verified the parent belongs to this user).
			let inherited: Awaited<ReturnType<SiteAgent["exportForChild"]>> = null;
			if (typeof body.parent === "string") {
				if (!SESSION_ID.test(body.parent)) return json({ error: "invalid parent" }, 400);
				inherited = await (await getAgentByName(env.SiteAgent, body.parent)).exportForChild();
				if (!inherited || inherited.user.id !== user.id) return json({ error: "parent session unavailable" }, 404);
			}
			const siteUrl = inherited?.siteUrl ?? (typeof body.siteUrl === "string" ? body.siteUrl.replace(/\/+$/, "") : "");
			const token = inherited?.token ?? (typeof body.token === "string" ? body.token : "");
			const expiresAt = inherited?.expiresAt ?? (typeof body.expiresAt === "string" ? body.expiresAt : "");
			if (!/^https:\/\//.test(siteUrl) || !/^ec_pat_/.test(token) || !Number.isFinite(Date.parse(expiresAt))) {
				return json({ error: "siteUrl (https), user, token and expiresAt are required" }, 400);
			}
			const sessionId = randomToken(16);
			const ticket = randomToken(32);
			const config: SessionConfig = {
				sessionId,
				ticket,
				siteUrl,
				siteName: inherited?.siteName ?? (typeof body.siteName === "string" ? body.siteName : ""),
				user: inherited?.user ?? { id: user.id, name: user.name ?? null, email: user.email ?? "", role: Number(user.role ?? 0) },
				token,
				expiresAt,
				pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : "",
				model: typeof body.model === "string" && body.model ? body.model : inherited?.model,
				reasoning: body.reasoning ?? inherited?.reasoning,
				skills: siteSkills(body.skills),
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
		const saying = url.pathname.match(/^\/session\/([A-Za-z0-9_-]{8,64})\/say$/);
		if (request.method === "POST" && saying) {
			const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
			if (!body || typeof body.text !== "string" || !body.text.trim()) return json({ error: "text required" }, 400);
			const agent = await getAgentByName(env.SiteAgent, saying[1]!);
			return json(await agent.say(body.text.slice(0, 4000)));
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
