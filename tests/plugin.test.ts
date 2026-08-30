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

function ctxWith(opts: { settings?: Record<string, unknown>; fetch?: (url: string, init?: RequestInit) => Promise<Response>; roles?: Array<{ id: string; slug: string; name: string; level: number; builtin: boolean }> | "unavailable" }) {
	const kv = new Map<string, unknown>(Object.entries(opts.settings ?? {}).map(([k, v]) => [`settings:${k}`, v]));
	const sessions = new Map<string, Record<string, unknown>>();
	const skills = new Map<string, Record<string, unknown>>();
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	// The instance's agent runtime as the plugin sees it: sessions opened (their specs) and ended.
	const specs: Array<Record<string, unknown>> = [];
	const ended: string[] = [];
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
			skills: {
				get: async (id: string) => skills.get(id) ?? null,
				put: async (id: string, data: Record<string, unknown>) => void skills.set(id, data),
				delete: async (id: string) => void skills.delete(id),
				query: async () => ({ items: [...skills.entries()].map(([id, data]) => ({ id, data })), hasMore: false }),
			},
		},
		users:
			opts.roles === "unavailable"
				? undefined
				: {
						listRoles: async () =>
							opts.roles ?? [
								{ id: "role:admin", slug: "admin", name: "Admin", level: 50, builtin: true },
								{ id: "role:editor", slug: "editor", name: "Editor", level: 40, builtin: true },
								{ id: "role:copywriter", slug: "copywriter", name: "Copywriter", level: 30, builtin: false },
							],
					},
		site: { name: "Site", url: "https://site.example", locale: "en" },
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return opts.fetch ? opts.fetch(url, init) : new Response("{}", { status: 200 });
			},
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
		agents: {
			session: async (spec: Record<string, unknown>) => {
				specs.push(spec);
				return { agent: `premium-cms-agent:${String(spec.id)}`, ticket: `t${specs.length}`, expiresAt: String(spec.expiresAt ?? "") };
			},
			endSession: async (id: string) => void ended.push(id),
		},
	};
	return { ctx, sessions, skills, calls, specs, ended };
}

const settings = { enabled: true, sessionHours: 2 };
type Caller = { id: string; email: string; name: string; role: number; createdAt: string; tokenAuth?: boolean };
const author: Caller & { roleId?: string | null } = { id: "u1", email: "a@example.com", name: "Ann", role: 30, roleId: "role:copywriter", createdAt: "2026-01-01T00:00:00Z" };
const admin: Caller & { roleId?: string | null } = { id: "u9", email: "o@example.com", name: "Omar", role: 50, roleId: "role:admin", createdAt: "2026-01-01T00:00:00Z" };
const viaToken: Caller = { ...author, tokenAuth: true };
const reader: Caller = { ...author, role: 10 };
const token = { token: `ec_pat_${"x".repeat(43)}`, tokenId: "tok1", expiresAt: "2026-12-31T00:00:00.000Z", pageUrl: "https://site.example/about" };

describe("session-only surface", () => {
	it("refuses API tokens, readers and anonymous callers on every route", async () => {
		const { ctx } = ctxWith({ settings });
		for (const name of ["toolbar", "session", "session/end", "settings", "settings/save", "skills", "skills/save", "skills/delete"]) {
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
			script: "https://site.example/_emdash/agents/toolbar.js",
			config: {
				session: "/_emdash/api/plugins/premium-cms-agent/session",
				end: "/_emdash/api/plugins/premium-cms-agent/session/end",
				purpose: "premium-cms-agent",
				sessionSeconds: 7200,
			},
		});
	});

	it("offers nothing while the plugin is off or the instance has no runtime", async () => {
		const off = ctxWith({ settings: { ...settings, enabled: false } });
		const r1 = (await route("toolbar")({ input: {}, user: author }, off.ctx)) as { success?: boolean; label?: string };
		expect(r1.success).toBe(false);
		expect(r1.label).toBeUndefined();
		const bare = ctxWith({ settings });
		delete (bare.ctx as { agents?: unknown }).agents;
		const r2 = (await route("toolbar")({ input: {}, user: author }, bare.ctx)) as { success?: boolean; error?: string };
		expect(r2.success).toBe(false);
		expect(r2.error).toMatch(/runtime/);
	});
});

describe("session", () => {
	it("hands the editor's token to the instance's runtime as a secret and returns only the ticket", async () => {
		const { ctx, sessions, specs } = ctxWith({ settings });
		const r = (await route("session")({ input: token, user: author }, ctx)) as Record<string, unknown>;
		expect(r).toMatchObject({ success: true, ticket: "t1", host: "https://site.example", expiresAt: token.expiresAt, skills: [] });
		const id = String(r.sessionId);
		expect(r.agent).toBe(`premium-cms-agent:${id}`);
		expect(JSON.stringify(r)).not.toContain(token.token);
		expect(specs[0]).toMatchObject({
			id,
			secrets: { token: token.token },
			browser: true,
			user: { id: "u1", role: 30 },
			expiresAt: token.expiresAt,
			mcp: [{ name: "site", url: "https://site.example/_emdash/api/mcp", headers: { Authorization: "Bearer {{secret:token}}" } }],
		});
		expect((specs[0].skills as Array<{ name: string }>).map((s) => s.name)).toEqual(["site-assistant"]);
		expect(sessions.get(id)).toMatchObject({ userId: "u1", tokenId: "tok1", status: "open", pageUrl: token.pageUrl });
	});

	it("opens a child chat from a parent chat without a token, and refuses someone else's parent", async () => {
		const { ctx, sessions, specs } = ctxWith({ settings });
		const first = (await route("session")({ input: token, user: author }, ctx)) as { sessionId: string };
		const child = (await route("session")({ input: { parent: first.sessionId, pageUrl: "https://site.example/pricing" }, user: author }, ctx)) as Record<string, unknown>;
		expect(child).toMatchObject({ success: true, ticket: "t2" });
		expect(specs[1]).toMatchObject({ parent: first.sessionId });
		expect(specs[1].secrets).toBeUndefined();
		expect(sessions.get(String(child.sessionId))).toMatchObject({ userId: "u1", tokenId: "tok1", status: "open" });
		const other = (await route("session")({ input: { parent: first.sessionId }, user: { ...author, id: "u2" } }, ctx)) as { success: boolean };
		expect(other.success).toBe(false);
	});

	it("rejects malformed tokens before opening anything on the runtime", async () => {
		const { ctx, specs } = ctxWith({ settings });
		const r = (await route("session")({ input: { ...token, token: "not-a-token" }, user: author }, ctx)) as { success: boolean };
		expect(r.success).toBe(false);
		expect(specs).toEqual([]);
	});

	it("ends only the caller's own session and reports the token to revoke", async () => {
		const { ctx, sessions, ended } = ctxWith({ settings });
		const first = (await route("session")({ input: token, user: author }, ctx)) as { sessionId: string };
		const other = (await route("session/end")({ input: { sessionId: first.sessionId }, user: { ...author, id: "u2" } }, ctx)) as { success: boolean };
		expect(other.success).toBe(false);
		const mine = (await route("session/end")({ input: { sessionId: first.sessionId }, user: author }, ctx)) as { success: boolean; tokenId: string };
		expect(mine).toEqual({ success: true, tokenId: "tok1" });
		expect(sessions.get(first.sessionId)).toMatchObject({ status: "closed" });
		expect(ended).toEqual([first.sessionId]);
	});
});

describe("skills", () => {
	const skill = (over: Record<string, unknown> = {}) => ({
		name: "Product page style",
		description: "Use when writing or editing a product page.",
		body: "# Product pages\n- Lead with the outcome.",
		roles: ["role:copywriter"],
		...over,
	});

	it("admins add, edit, toggle and delete skills; the id is the slug of the name", async () => {
		const { ctx, skills } = ctxWith({ settings });
		const saved = (await route("skills/save")({ input: skill(), user: admin }, ctx)) as { success: boolean; skill: { id: string; roles: string[]; enabled: boolean; createdBy: string } };
		expect(saved.success).toBe(true);
		expect(saved.skill).toMatchObject({ id: "product-page-style", roles: ["role:copywriter"], enabled: true, createdBy: "Omar" });
		const dup = (await route("skills/save")({ input: skill(), user: admin }, ctx)) as { success: boolean; error: string };
		expect(dup.success).toBe(false);
		expect(dup.error).toMatch(/already exists/);
		const edited = (await route("skills/save")({ input: { ...skill({ description: "Use for product pages and their copy." }), id: "product-page-style", roles: [] }, user: admin }, ctx)) as { success: boolean; skill: { roles: string[]; description: string } };
		expect(edited.success).toBe(true);
		expect(edited.skill).toMatchObject({ roles: [], description: "Use for product pages and their copy." });
		expect(skills.size).toBe(1);
		const gone = (await route("skills/delete")({ input: { id: "product-page-style" }, user: admin }, ctx)) as { success: boolean };
		expect(gone.success).toBe(true);
		expect(skills.size).toBe(0);
	});

	it("rejects unusable skills and lets nobody below admin change them", async () => {
		const { ctx } = ctxWith({ settings });
		const bad = (await route("skills/save")({ input: skill({ description: "" }), user: admin }, ctx)) as { success: boolean; error: string };
		expect(bad.success).toBe(false);
		expect(bad.error).toMatch(/description/);
		const reserved = (await route("skills/save")({ input: skill({ name: "site assistant" }), user: admin }, ctx)) as { success: boolean; error: string };
		expect(reserved.success).toBe(false);
		const asAuthor = (await route("skills/save")({ input: skill(), user: author }, ctx)) as { success: boolean; error: string };
		expect(asAuthor.success).toBe(false);
		expect(asAuthor.error).toMatch(/admins/i);
	});

	it("a chat carries the enabled skills assigned to the editor's role, plus the ones for everyone", async () => {
		const { ctx, specs } = ctxWith({ settings });
		await route("skills/save")({ input: skill(), user: admin }, ctx);
		await route("skills/save")({ input: skill({ name: "House style", description: "Always.", roles: [] }), user: admin }, ctx);
		await route("skills/save")({ input: skill({ name: "Admin only", description: "Admins.", roles: ["role:admin"] }), user: admin }, ctx);
		await route("skills/save")({ input: skill({ name: "Paused", description: "Paused.", roles: [], enabled: false }), user: admin }, ctx);
		const r = (await route("session")({ input: token, user: author }, ctx)) as { success: boolean; skills: string[] };
		expect(r.success).toBe(true);
		expect(r.skills.sort()).toEqual(["house-style", "product-page-style"]);
		const sent = (specs[0].skills as Array<{ name: string; description: string; body: string }>).filter((s) => s.name !== "site-assistant");
		expect(sent.map((s) => s.name).sort()).toEqual(["house-style", "product-page-style"]);
		expect(sent[0]).toMatchObject({ description: expect.any(String), body: expect.any(String) });
		const mine = (await route("skills")({ input: {}, user: author }, ctx)) as { success: boolean; items: unknown[]; roles: Array<{ id: string }>; mine: string[] };
		expect(mine.items).toHaveLength(4);
		expect(mine.roles.map((x) => x.id)).toContain("role:copywriter");
		expect((mine as unknown as { rolesSource: string }).rolesSource).toBe("site");
		expect(mine.mine.sort()).toEqual(["house-style", "product-page-style"]);
	});

	it("the Skills page lists skills with a role picker from the site's roles, and its form saves through block interactions", async () => {
		const { ctx, skills } = ctxWith({ settings });
		const empty = (await route("admin")({ input: { type: "page_load", page: "/skills" }, user: admin }, ctx)) as { blocks: Array<{ type: string; fields?: Array<{ action_id: string; options?: Array<{ value: string }> }> }> };
		expect(empty.blocks.map((b) => b.type)).toEqual(["header", "context", "table", "divider", "section", "form"]);
		expect((empty.blocks.find((b) => b.type === "form") as { block_id?: string }).block_id).toMatch(/^skill:new-/);
		const rolesField = empty.blocks.find((b) => b.type === "form")!.fields!.find((f) => f.action_id === "roles")!;
		expect(rolesField.options!.map((o) => o.value)).toEqual(["role:admin", "role:editor", "role:copywriter"]);
		const saved = (await route("admin")({ input: { type: "form_submit", action_id: "skills.save", block_id: "skill:new", values: skill() }, user: admin }, ctx)) as { blocks: Array<{ type: string; description?: string; rows?: Array<Record<string, string>>; elements?: Array<{ action_id: string; value: string }> }> };
		expect(saved.blocks[1]).toMatchObject({ type: "banner", description: expect.stringContaining("saved") });
		expect(saved.blocks.find((b) => b.type === "table")!.rows![0]).toMatchObject({ name: "product-page-style", roles: "Copywriter", status: "enabled" });
		expect(saved.blocks.find((b) => b.type === "actions")!.elements!.map((e) => e.action_id)).toEqual(["skills.edit", "skills.toggle", "skills.delete"]);
		const editing = (await route("admin")({ input: { type: "block_action", action_id: "skills.edit", value: "product-page-style" }, user: admin }, ctx)) as { blocks: Array<{ type: string; block_id?: string; fields?: Array<{ action_id: string; initial_value?: unknown }> }> };
		const form = editing.blocks.find((b) => b.type === "form")!;
		expect(form.block_id).toBe("skill:product-page-style");
		expect(form.fields!.find((f) => f.action_id === "roles")!.initial_value).toEqual(["role:copywriter"]);
		await route("admin")({ input: { type: "block_action", action_id: "skills.toggle", value: "product-page-style" }, user: admin }, ctx);
		expect(skills.get("product-page-style")).toMatchObject({ enabled: false });
		await route("admin")({ input: { type: "block_action", action_id: "skills.delete", value: "product-page-style" }, user: admin }, ctx);
		expect(skills.size).toBe(0);
		// An author sees the list only, and cannot save through the page either.
		await route("skills/save")({ input: skill(), user: admin }, ctx);
		const viewer = (await route("admin")({ input: { type: "page_load", page: "/skills" }, user: author }, ctx)) as { blocks: Array<{ type: string }> };
		expect(viewer.blocks.map((b) => b.type)).toEqual(["header", "context", "table", "context"]);
		await route("admin")({ input: { type: "form_submit", action_id: "skills.save", block_id: "skill:new", values: skill({ name: "Sneaky" }) }, user: author }, ctx);
		expect(skills.size).toBe(1);
	});

	it("offers the built-in roles when the site's roles cannot be listed", async () => {
		const { ctx } = ctxWith({ settings, roles: "unavailable" });
		const page = (await route("admin")({ input: { type: "page_load", page: "/skills" }, user: admin }, ctx)) as { blocks: Array<{ type: string; text?: string; fields?: Array<{ action_id: string; options?: Array<{ value: string }> }> }> };
		const rolesField = page.blocks.find((b) => b.type === "form")!.fields!.find((f) => f.action_id === "roles")!;
		expect(rolesField.options!.map((o) => o.value)).toEqual(["role:admin", "role:editor", "role:author", "role:contributor", "role:subscriber"]);
		expect(page.blocks.some((b) => b.type === "context" && /built-in roles/.test(b.text ?? ""))).toBe(true);
	});
});
