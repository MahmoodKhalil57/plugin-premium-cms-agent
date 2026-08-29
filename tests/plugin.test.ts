/**
 * Tests run against the plugin object directly — no CMS, no network. The
 * context double covers kv, the `sessions` storage, `site` and `http`. What
 * matters: every route is session-only (API tokens refused), the toolbar
 * descriptor, and the session hand-off to the worker.
 */

import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const route = (name: string) => (plugin.routes![name] as { handler: Handler }).handler;

function ctxWith(opts: { settings?: Record<string, unknown>; fetch?: (url: string, init?: RequestInit) => Promise<Response> }) {
	const kv = new Map<string, unknown>(Object.entries(opts.settings ?? {}).map(([k, v]) => [`settings:${k}`, v]));
	const sessions = new Map<string, Record<string, unknown>>();
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const ctx = {
		kv: {
			get: async (k: string) => kv.get(k) ?? null,
			set: async (k: string, v: unknown) => void kv.set(k, v),
		},
		storage: {
			sessions: {
				get: async (id: string) => sessions.get(id) ?? null,
				put: async (id: string, data: Record<string, unknown>) => void sessions.set(id, data),
				query: async () => ({ items: [...sessions.entries()].map(([id, data]) => ({ id, data })), hasMore: false }),
			},
		},
		site: { name: "Site", url: "https://site.example", locale: "en" },
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return opts.fetch ? opts.fetch(url, init) : new Response("{}", { status: 200 });
			},
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	};
	return { ctx, sessions, calls };
}

const settings = { agentKey: "k", agentUrl: "https://agent.example", enabled: true, sessionHours: 2 };
type Caller = { id: string; email: string; name: string; role: number; createdAt: string; tokenAuth?: boolean };
const author: Caller = { id: "u1", email: "a@example.com", name: "Ann", role: 30, createdAt: "2026-01-01T00:00:00Z" };
const viaToken: Caller = { ...author, tokenAuth: true };
const reader: Caller = { ...author, role: 10 };
const token = { token: `ec_pat_${"x".repeat(43)}`, tokenId: "tok1", expiresAt: "2026-12-31T00:00:00.000Z", pageUrl: "https://site.example/about" };

describe("session-only surface", () => {
	it("refuses API tokens, readers and anonymous callers on every route", async () => {
		const { ctx } = ctxWith({ settings });
		for (const name of ["toolbar", "session", "session/end", "settings", "settings/save"]) {
			for (const user of [viaToken, reader, undefined]) {
				const r = (await route(name)({ input: {}, user }, ctx)) as { success: boolean; error?: string };
				expect(r.success, `${name} for ${user ? (user.tokenAuth ? "token" : "reader") : "anonymous"}`).toBe(false);
			}
		}
		const page = (await route("admin")({ input: { type: "page_load" }, user: viaToken }, ctx)) as { blocks: Array<{ type: string }> };
		expect(page.blocks.map((b) => b.type)).toEqual(["banner"]);
	});

	it("exposes no MCP tools", () => {
		expect((plugin as { mcpTools?: unknown }).mcpTools).toBeUndefined();
	});
});

describe("toolbar", () => {
	it("describes the Agent button for an editor session", async () => {
		const { ctx } = ctxWith({ settings });
		const r = (await route("toolbar")({ input: {}, user: author }, ctx)) as { label: string; script: string; config: Record<string, unknown> };
		expect(r).toEqual({
			label: "Agent",
			script: "https://agent.example/toolbar.js",
			config: {
				session: "/_emdash/api/plugins/premium-cms-agent/session",
				end: "/_emdash/api/plugins/premium-cms-agent/session/end",
				purpose: "premium-cms-agent",
				sessionSeconds: 7200,
			},
		});
	});

	it("offers nothing while the key is missing or the plugin is off", async () => {
		const off = ctxWith({ settings: { ...settings, enabled: false } });
		expect(((await route("toolbar")({ input: {}, user: author }, off.ctx)) as { success: boolean }).success).toBe(false);
		const noKey = ctxWith({ settings: { ...settings, agentKey: "" } });
		expect(((await route("toolbar")({ input: {}, user: author }, noKey.ctx)) as { success: boolean }).success).toBe(false);
	});
});

describe("session", () => {
	it("hands the editor's token to the worker and returns only the ticket", async () => {
		const { ctx, sessions, calls } = ctxWith({
			settings,
			fetch: async (url) => (url.endsWith("/session") ? Response.json({ sessionId: "s1", ticket: "t1", expiresAt: token.expiresAt }) : Response.json({})),
		});
		const r = (await route("session")({ input: token, user: author }, ctx)) as Record<string, unknown>;
		expect(r).toEqual({ success: true, sessionId: "s1", ticket: "t1", host: "https://agent.example", expiresAt: token.expiresAt });
		const sent = JSON.parse(String(calls[0]?.init?.body));
		expect(calls[0]?.url).toBe("https://agent.example/session");
		expect(sent).toMatchObject({ siteUrl: "https://site.example", token: token.token, tokenId: "tok1", user: { id: "u1", role: 30 } });
		expect(sessions.get("s1")).toMatchObject({ userId: "u1", tokenId: "tok1", status: "open", pageUrl: token.pageUrl });
	});

	it("rejects malformed tokens before talking to the worker", async () => {
		const { ctx, calls } = ctxWith({ settings });
		const r = (await route("session")({ input: { ...token, token: "not-a-token" }, user: author }, ctx)) as { success: boolean };
		expect(r.success).toBe(false);
		expect(calls).toEqual([]);
	});

	it("ends only the caller's own session and reports the token to revoke", async () => {
		const { ctx, sessions, calls } = ctxWith({
			settings,
			fetch: async (url) => (url.endsWith("/session") ? Response.json({ sessionId: "s1", ticket: "t1" }) : Response.json({ ok: true })),
		});
		await route("session")({ input: token, user: author }, ctx);
		const other = (await route("session/end")({ input: { sessionId: "s1" }, user: { ...author, id: "u2" } }, ctx)) as { success: boolean };
		expect(other.success).toBe(false);
		const mine = (await route("session/end")({ input: { sessionId: "s1" }, user: author }, ctx)) as { success: boolean; tokenId: string };
		expect(mine).toEqual({ success: true, tokenId: "tok1" });
		expect(sessions.get("s1")).toMatchObject({ status: "closed" });
		expect(calls.some((c) => c.url === "https://agent.example/session/s1" && c.init?.method === "DELETE")).toBe(true);
	});
});
