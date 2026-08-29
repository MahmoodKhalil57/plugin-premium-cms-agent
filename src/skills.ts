/**
 * Skills an owner writes for the site assistant, and which roles get them.
 * A skill is the same shape as a bundled Think skill — a name, a one-line
 * description that tells the model when to use it, and the instructions —
 * stored in the plugin's `skills` collection and handed to the worker when a
 * chat opens, filtered by the editor's role. Pure helpers here; the routes
 * and the admin page are in plugin.ts.
 */

export interface Skill {
	/** Slug, unique per site; also the name the model sees. */
	id: string;
	name: string;
	description: string;
	body: string;
	/** Role ids (`role:admin`, custom ids). Empty = every role. */
	roles: string[];
	enabled: boolean;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

/** What the worker receives. */
export interface SkillPayload {
	name: string;
	description: string;
	body: string;
}

export const MAX_SKILLS = 30;
export const MAX_BODY = 24_000;
export const MAX_DESCRIPTION = 500;
/** The bundled skill's name, which a site skill may not shadow. */
export const RESERVED_NAMES = new Set(["site-assistant"]);

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** Validate a submitted skill; the id is derived from the name unless editing an existing one. */
export function parseSkill(
	input: Record<string, unknown>,
	existing: Skill | null,
	who: string,
	now: string,
): { ok: true; skill: Skill } | { ok: false; error: string } {
	const name = typeof input.name === "string" ? input.name.trim() : "";
	const id = existing?.id ?? slugify(name);
	if (!name || !NAME.test(id)) return { ok: false, error: "Give the skill a short name (letters, digits and dashes)." };
	if (RESERVED_NAMES.has(id)) return { ok: false, error: `"${id}" is the assistant's bundled skill; pick another name.` };
	const description = typeof input.description === "string" ? input.description.trim() : "";
	if (!description) return { ok: false, error: "The description tells the assistant when to use the skill — it is required." };
	if (description.length > MAX_DESCRIPTION) return { ok: false, error: `Keep the description under ${MAX_DESCRIPTION} characters.` };
	const body = typeof input.body === "string" ? input.body.trim() : "";
	if (!body) return { ok: false, error: "The instructions are required." };
	if (body.length > MAX_BODY) return { ok: false, error: `Keep the instructions under ${MAX_BODY} characters.` };
	const roles = parseRoles(input.roles);
	const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true || input.enabled === "true";
	return {
		ok: true,
		skill: {
			id,
			name: existing ? name : name,
			description,
			body,
			roles,
			enabled,
			createdBy: existing?.createdBy ?? who,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		},
	};
}

/** Role ids from a checkbox value (array) or a comma-separated string. */
export function parseRoles(raw: unknown): string[] {
	const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
	return [...new Set(list.map((r) => r.trim()).filter(Boolean))].slice(0, 50);
}

export function isSkill(v: unknown): v is Skill {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as Skill).id === "string" &&
		typeof (v as Skill).body === "string" &&
		Array.isArray((v as Skill).roles)
	);
}

/** The enabled skills a user with this role gets: those assigned to the role, plus those assigned to no role in particular. */
export function skillsFor(skills: Skill[], roleId: string | null | undefined): SkillPayload[] {
	return skills
		.filter((s) => s.enabled && (s.roles.length === 0 || (roleId ? s.roles.includes(roleId) : false)))
		.map((s) => ({ name: s.id, description: s.description, body: s.body }));
}

/** The built-in roles, for a role picker when the site's list cannot be read. */
export const BUILTIN_ROLES = [
	{ id: "role:admin", name: "Admin", level: 50 },
	{ id: "role:editor", name: "Editor", level: 40 },
	{ id: "role:author", name: "Author", level: 30 },
	{ id: "role:contributor", name: "Contributor", level: 20 },
	{ id: "role:subscriber", name: "Subscriber", level: 10 },
] as const;
