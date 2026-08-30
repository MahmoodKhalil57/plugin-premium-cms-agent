import { describe, expect, it } from "vitest";

import { runtimeHostFor } from "../src/plugin.js";

const ctx = { site: { platformUrl: "https://p01abc.premium-cms.com" } } as never;
const site = "https://beta.example.com";

describe("runtimeHostFor", () => {
	it("uses the page's own origin on one of this site's previews", () => {
		expect(runtimeHostFor(ctx, "https://p01abc--pr-21.premium-cms.com/about?x=1", site)).toBe("https://p01abc--pr-21.premium-cms.com");
		expect(runtimeHostFor(ctx, "https://p01abc--main-b-1.premium-cms.com/", site)).toBe("https://p01abc--main-b-1.premium-cms.com");
	});
	it("falls back to the site URL everywhere else", () => {
		expect(runtimeHostFor(ctx, "https://beta.example.com/page", site)).toBe(site);
		expect(runtimeHostFor(ctx, "https://p01zzz--pr-1.premium-cms.com/", site)).toBe(site);
		expect(runtimeHostFor(ctx, "https://p01abc--pr-1.evil.example/", site)).toBe(site);
		expect(runtimeHostFor(ctx, "http://p01abc--pr-1.premium-cms.com/", site)).toBe(site);
		expect(runtimeHostFor(ctx, "not a url", site)).toBe(site);
		expect(runtimeHostFor(ctx, "", site)).toBe(site);
		expect(runtimeHostFor({ site: {} } as never, "https://p01abc--pr-1.premium-cms.com/", site)).toBe(site);
	});
});
