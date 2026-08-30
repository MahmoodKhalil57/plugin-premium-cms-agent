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
 *   agent     The instance's own Think agent (`ctx.agents`, hosted by the
 *             site's instance) with two MCP servers: the site's own MCP
 *             endpoint (acting as the editor, within their permissions) and a
 *             browser bridge — an MCP server whose tools run inside the
 *             editor's tab (screenshots, DOM and style snapshots, console,
 *             clicks, evaluate). Nothing runs outside the instance.
 *   scope     Every route here is session-only: a request authenticated by an
 *             API token is refused, and the plugin exposes no MCP tools, so
 *             the assistant cannot be reached from another agent.
 *   skills    Owners write skills for the assistant on the plugin's Skills
 *             page (name, when-to-use description, instructions) and assign
 *             them to roles; the ones matching the editor's role travel to
 *             the worker with each chat. `ctx.users.listRoles()` feeds the
 *             role picker; `ctx.user.roleId` is what a chat is matched on.
 *   storage   `sessions` — one row per chat session (who, when, which token);
 *             `skills` — one row per skill.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

import { DEFAULTS, readSettings, saveSettings, type Settings } from "./settings.js";
import { SITE_ASSISTANT_SKILL } from "./skill.js";
import { BUILTIN_ROLES, isSkill, MAX_SKILLS, parseSkill, skillsFor, type Skill } from "./skills.js";

const PLUGIN_ID = "premium-cms-agent";
const SESSION_ROUTE = `/_emdash/api/plugins/${PLUGIN_ID}/session`;
const END_ROUTE = `/_emdash/api/plugins/${PLUGIN_ID}/session/end`;
/** Same threshold as the toolbar: authors and above. */
const MIN_ROLE = 30;
/** Admins manage the assistant's skills. */
const ADMIN_LEVEL = 50;
const SKILLS_PAGE = "/skills";
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
	/** The role held (`role:admin`, a custom role id …); what skills are matched on. */
	roleId?: string | null;
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
	if (!agentsOf(ctx)) return { ok: false, error: "This instance does not host the agent runtime yet." };
	return { ok: true, settings };
}

/** The instance's agent runtime, as the plugin context exposes it (capability agents:run). */
interface AgentsLike {
	session(spec: Record<string, unknown>): Promise<{ agent: string; ticket: string; expiresAt: string }>;
	endSession(id: string): Promise<void>;
}

function agentsOf(ctx: PluginContext): AgentsLike | null {
	return (ctx as { agents?: AgentsLike }).agents ?? null;
}

function newSessionId(): string {
	return crypto.randomUUID().replace(/-/g, "");
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

// ── Skills ───────────────────────────────────────────────────────────────

function canManage(user: Caller): boolean {
	return user.role >= ADMIN_LEVEL;
}

async function listSkills(ctx: PluginContext): Promise<Skill[]> {
	const r = await ctx.storage.skills!.query({ orderBy: { updatedAt: "desc" }, limit: 100 });
	return r.items.map((i) => i.data).filter(isSkill);
}

async function getSkill(ctx: PluginContext, id: string): Promise<Skill | null> {
	const row = id ? await ctx.storage.skills!.get(id) : null;
	return isSkill(row) ? row : null;
}

async function putSkill(ctx: PluginContext, skill: Skill): Promise<void> {
	await ctx.storage.skills!.put(skill.id, skill);
}

/** The site's roles for the picker — from core when the capability is bridged, else the built-in five (and why). */
async function siteRoles(ctx: PluginContext): Promise<{ roles: Array<{ id: string; name: string; slug: string; level: number }>; source: "site" | "builtin"; reason?: string }> {
	// `listRoles` arrived with core 0.35.41; typed structurally so the plugin also runs (with the built-in list) on older cores.
	const users = ctx.users as { listRoles?: () => Promise<Array<{ id: string; name: string; slug?: string; level: number }>> } | undefined;
	let reason = !users ? "the users capability is not bridged" : typeof users.listRoles !== "function" ? "this core has no listRoles (needs 0.35.41+)" : "";
	if (!reason) {
		try {
			const roles = await users!.listRoles!();
			if (roles?.length) return { roles: roles.map((r) => ({ id: r.id, name: r.name, slug: r.slug ?? r.id.replace(/^role:/, ""), level: r.level })), source: "site" };
			reason = "the site returned no roles";
		} catch (error) {
			reason = String(error instanceof Error ? error.message : error);
			ctx.log.warn("roles could not be listed; offering the built-in ones", error);
		}
	}
	return { roles: BUILTIN_ROLES.map((r) => ({ id: r.id, name: r.name, slug: r.id.replace(/^role:/, ""), level: r.level })), source: "builtin", reason };
}

/** Validate and store a skill (new, or the given existing one). */
async function saveSkill(
	ctx: PluginContext,
	input: Record<string, unknown>,
	existing: Skill | null,
	user: Caller,
): Promise<{ ok: true; skill: Skill } | { ok: false; error: string }> {
	const parsed = parseSkill(input, existing, user.name || user.email, now());
	if (!parsed.ok) return parsed;
	if (!existing) {
		const all = await listSkills(ctx);
		if (all.length >= MAX_SKILLS) return { ok: false, error: `A site can hold ${MAX_SKILLS} skills; remove one first.` };
		if (all.some((s) => s.id === parsed.skill.id)) return { ok: false, error: `A skill named "${parsed.skill.id}" already exists — edit it instead.` };
	}
	await putSkill(ctx, parsed.skill);
	return parsed;
}

// ── Plugin ───────────────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			for (const [k, v] of Object.entries(DEFAULTS)) {
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
					// Served by the instance itself (the runtime's public endpoint).
					script: `${ctx.site.url.replace(/\/+$/, "")}/_emdash/agents/toolbar.js`,
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
				const skills = skillsFor(await listSkills(ctx), user.roleId);
				const agents = agentsOf(ctx)!;
				const sessionId = newSessionId();
				const siteUrl = ctx.site.url.replace(/\/+$/, "");
				let opened: { agent: string; ticket: string; expiresAt: string };
				try {
					// The editor's token lives on the runtime only (`{{secret:token}}` is
					// expanded there); child chats inherit it from their parent session.
					opened = await agents.session({
						id: sessionId,
						...(parentId ? { parent: parentId } : { secrets: { token } }),
						model: r.settings.model,
						reasoning: r.settings.reasoning,
						systemPrompt:
							"You are the site assistant of an EmDash site, chatting with a signed-in editor from the site's toolbar. Activate the site-assistant skill and follow it. You act through the connected MCP tools as that editor — content, media, schema, settings and the GitHub coding agent are all reachable that way; you cannot run code anywhere else.",
						skills: [SITE_ASSISTANT_SKILL, ...skills],
						mcp: [
							{
								name: "site",
								url: `${siteUrl}/_emdash/api/mcp`,
								headers: { Authorization: "Bearer {{secret:token}}", "X-EmDash-Request": "1" },
							},
						],
						browser: true,
						user: { id: user.id, name: user.name, email: user.email, role: user.role },
						expiresAt,
						maxSteps: 60,
					});
				} catch (error) {
					return { success: false, error: `agent: ${String(error instanceof Error ? error.message : error)}` };
				}
				const session: Session = {
					id: sessionId,
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
				return { success: true, sessionId: session.id, agent: opened.agent, ticket: opened.ticket, host: runtimeHostFor(ctx, pageUrl, siteUrl), expiresAt, skills: skills.map((k) => k.name) };
			},
		},

		/** Close a session on the runtime. The browser revokes the token itself (core, session-only). */
		"session/end": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const id = typeof input.sessionId === "string" ? input.sessionId : "";
				const row = id ? await ctx.storage.sessions!.get(id) : null;
				if (!isSession(row) || row.userId !== who.user.id) return { success: false, error: "Unknown session." };
				await agentsOf(ctx)?.endSession(id).catch(() => undefined);
				await ctx.storage.sessions!.put(id, { ...row, status: "closed", updatedAt: now() });
				return { success: true, tokenId: row.tokenId };
			},
		},

		/** The site's skills and roles (editors may look; admins manage them on the Skills page). */
		skills: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				const items = await listSkills(ctx);
				const r = await siteRoles(ctx);
				return { success: true, items, roles: r.roles, rolesSource: r.source, ...(r.reason ? { rolesReason: r.reason } : {}), mine: skillsFor(items, who.user.roleId).map((k) => k.name) };
			},
		},

		/** Create or update a skill: `{ id?, name, description, body, roles: string[], enabled }`. */
		"skills/save": {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				if (!canManage(who.user)) return { success: false, error: "Only admins can change the assistant's skills." };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const existing = typeof input.id === "string" ? await getSkill(ctx, input.id) : null;
				if (typeof input.id === "string" && input.id && !existing) return { success: false, error: `No skill "${input.id}".` };
				const r = await saveSkill(ctx, input, existing, who.user);
				return r.ok ? { success: true, skill: r.skill } : { success: false, error: r.error };
			},
		},

		"skills/delete": {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				if (!canManage(who.user)) return { success: false, error: "Only admins can change the assistant's skills." };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const skill = typeof input.id === "string" ? await getSkill(ctx, input.id) : null;
				if (!skill) return { success: false, error: "No such skill." };
				await ctx.storage.skills!.delete(skill.id);
				return { success: true, id: skill.id };
			},
		},

		settings: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { success: false, error: who.error };
				return { success: true, settings: await readSettings(ctx) };
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
				return { success: true, settings: await readSettings(ctx) };
			},
		},

		admin: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const who = sessionOnly(routeCtx);
				if (!who.ok) return { blocks: [{ type: "banner", variant: "alert", description: who.error }] };
				const i = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					block_id?: string;
					value?: unknown;
					values?: Record<string, unknown>;
				};
				if (i.page === SKILLS_PAGE || (i.action_id ?? "").startsWith("skills.")) return skillsInteraction(ctx, who.user, i);
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

/**
 * Where the panel reaches the runtime. Cookies and CORS are per origin, so on
 * one of this site's git-served previews (`https://<rn>--<label>.<zone>`, the
 * platform origin being `<rn>.<zone>`) the chat and the browser bridge use the
 * page's own origin — the instance serves `/_emdash/agents/*` there too.
 * Anywhere else it is the site URL. `pageUrl` comes from the browser, so it may
 * only ever select one of this site's own hostnames.
 */
export function runtimeHostFor(ctx: PluginContext, pageUrl: string, siteUrl: string): string {
	const platform = (ctx.site as { platformUrl?: string }).platformUrl;
	if (!platform || !pageUrl) return siteUrl;
	try {
		const page = new URL(pageUrl);
		const host = new URL(platform).hostname.toLowerCase();
		const dot = host.indexOf(".");
		if (page.protocol !== "https:" || dot <= 0) return siteUrl;
		const m = page.hostname.toLowerCase().match(/^([a-z0-9]+)--([a-z0-9][a-z0-9-]{0,40})\.(.+)$/);
		if (m && m[1] === host.slice(0, dot) && m[3] === host.slice(dot + 1)) return page.origin;
	} catch {
		// not a URL: fall through to the site
	}
	return siteUrl;
}

export default plugin;

// ── Admin page ───────────────────────────────────────────────────────────

async function buildPage(ctx: PluginContext, notice?: string) {
	const settings = await readSettings(ctx);
	const blocks: unknown[] = [{ type: "header", text: "Site Agent" }];
	if (notice) blocks.push({ type: "banner", description: notice });
	blocks.push({
		type: "context",
		text: "Editors open the assistant from the EmDash toolbar on the site (the Agent button). It runs inside this site's own instance and reaches the site's MCP endpoint as the editor and the editor's own browser. It is not reachable from API tokens or other MCP clients. Skills — instructions the assistant follows for a given role — are managed on the Agent skills page.",
	});

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

// ── Skills page ──────────────────────────────────────────────────────────

interface SkillsInteraction {
	type: string;
	page?: string;
	action_id?: string;
	block_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

/** One admin page (`/skills`): the list, per-skill actions, and the add/edit form. Block pages are stateless, so the form's block_id carries the skill being edited. */
async function skillsInteraction(ctx: PluginContext, user: Caller, i: SkillsInteraction) {
	let notice: string | undefined;
	let editing: Skill | null = null;
	const denied = "Only admins can change the assistant's skills.";
	if (i.type === "block_action" && typeof i.action_id === "string") {
		const id = typeof i.value === "string" ? i.value : "";
		if (i.action_id === "skills.edit") {
			editing = await getSkill(ctx, id);
		} else if (i.action_id === "skills.new") {
			editing = null;
		} else if (!canManage(user)) {
			notice = denied;
		} else if (i.action_id === "skills.delete") {
			const skill = await getSkill(ctx, id);
			if (skill) {
				await ctx.storage.skills!.delete(skill.id);
				notice = `Skill "${skill.name}" deleted.`;
			}
		} else if (i.action_id === "skills.toggle") {
			const skill = await getSkill(ctx, id);
			if (skill) {
				await putSkill(ctx, { ...skill, enabled: !skill.enabled, updatedAt: now() });
				notice = `Skill "${skill.name}" ${skill.enabled ? "disabled" : "enabled"}.`;
			}
		}
	}
	if (i.type === "form_submit" && i.action_id === "skills.save") {
		if (!canManage(user)) {
			notice = denied;
		} else {
			const id = (i.block_id ?? "").startsWith("skill:") ? i.block_id!.slice("skill:".length) : "";
			const existing = id && !id.startsWith("new") ? await getSkill(ctx, id) : null;
			const r = await saveSkill(ctx, i.values ?? {}, existing, user);
			if (r.ok) notice = `Skill "${r.skill.name}" saved${r.skill.roles.length ? "" : " — every role gets it"}.`;
			else {
				notice = r.error;
				editing = existing;
			}
		}
	}
	return buildSkillsPage(ctx, user, { notice, editing });
}

async function buildSkillsPage(ctx: PluginContext, user: Caller, opts: { notice?: string; editing?: Skill | null } = {}) {
	const skills = await listSkills(ctx);
	const { roles, source, reason } = await siteRoles(ctx);
	const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
	const manage = canManage(user);
	const blocks: unknown[] = [{ type: "header", text: "Agent skills" }];
	if (opts.notice) blocks.push({ type: "banner", description: opts.notice });
	blocks.push({
		type: "context",
		text: "A skill is a set of instructions the site assistant follows when its description fits the conversation — house style, how to write a product page, what never to touch. Assign a skill to roles and every editor with one of those roles gets it in their chats; a skill with no role assigned goes to everyone. Changes apply to chats opened afterwards.",
	});
	blocks.push({
		type: "table",
		block_id: "skills",
		page_action_id: "skills_page",
		empty_text: manage ? "No skills yet — add the first one below." : "No skills yet.",
		columns: [
			{ key: "name", label: "Skill", format: "code" },
			{ key: "description", label: "When the assistant uses it", format: "text" },
			{ key: "roles", label: "Roles", format: "text" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "updated", label: "Updated", format: "relative_time" },
		],
		rows: skills.map((s) => ({
			name: s.id,
			description: s.description.length > 140 ? `${s.description.slice(0, 139)}…` : s.description,
			roles: s.roles.length ? s.roles.map(roleName).join(", ") : "Everyone",
			status: s.enabled ? "enabled" : "disabled",
			updated: s.updatedAt,
		})),
	});
	if (source === "builtin") {
		blocks.push({ type: "context", text: `Role list: the built-in roles (the site's own roles could not be read${reason ? ` — ${reason}` : ""}).` });
	}
	if (!manage) {
		blocks.push({ type: "context", text: "Admins add and edit skills here." });
		return { blocks };
	}
	for (const s of skills) {
		blocks.push({
			type: "actions",
			elements: [
				{ type: "button", action_id: "skills.edit", label: `Edit ${s.name}`, value: s.id, style: "secondary" },
				{ type: "button", action_id: "skills.toggle", label: s.enabled ? "Disable" : "Enable", value: s.id, style: "secondary" },
				{
					type: "button",
					action_id: "skills.delete",
					label: "Delete",
					value: s.id,
					style: "danger",
					confirm: { title: `Delete "${s.name}"?`, text: "Chats opened afterwards will not have it. This cannot be undone.", confirm: "Delete", deny: "Keep", style: "danger" },
				},
			],
		});
	}
	blocks.push({ type: "divider" });
	const editing = opts.editing ?? null;
	if (editing) {
		blocks.push({ type: "banner", title: `Editing "${editing.name}"`, description: "Save below, or start a new skill instead." });
		blocks.push({ type: "actions", elements: [{ type: "button", action_id: "skills.new", label: "New skill instead", style: "secondary" }] });
	} else {
		blocks.push({ type: "section", text: `Add a skill (${skills.length} of ${MAX_SKILLS})` });
	}
	blocks.push({
		type: "form",
		// A fresh block id per render of the "new" form, so the admin widget does not keep the values just saved.
		block_id: `skill:${editing?.id ?? `new-${skills.length}-${Date.now().toString(36)}`}`,
		fields: [
			{ type: "text_input", action_id: "name", label: "Name", placeholder: "product-page-style", initial_value: editing?.name ?? "" },
			{
				type: "text_input",
				action_id: "description",
				label: "When to use it (one line — the assistant reads this to decide)",
				placeholder: "Use when writing or editing a product page or its copy.",
				initial_value: editing?.description ?? "",
			},
			{
				type: "text_input",
				action_id: "body",
				label: "Instructions (markdown)",
				multiline: true,
				placeholder: "# Product pages\n- Lead with the outcome, not the feature…",
				initial_value: editing?.body ?? "",
			},
			{
				type: "checkbox",
				action_id: "roles",
				label: "Roles that get this skill (none = everyone)",
				options: roles.map((r) => ({ label: `${r.name} (${r.slug})`, value: r.id })),
				initial_value: editing?.roles ?? [],
			},
			{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: editing?.enabled ?? true },
		],
		submit: { label: editing ? "Save changes" : "Add skill", action_id: "skills.save" },
	});
	return { blocks };
}
