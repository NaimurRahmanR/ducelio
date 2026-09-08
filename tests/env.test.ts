import { describe, expect, it } from "vitest";
import { readConfig } from "@/lib/env";
describe("configuration boundaries", () => {
  it("fails closed without complete configuration", () => { expect(readConfig({}).configured).toBe(false); expect(readConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }).configured).toBe(false); });
  it("requires explicit provider enablement", () => { expect(readConfig({AUTH_GOOGLE_ENABLED: "true"}).google).toBe(false); });
  it("rejects malformed, non-http and non-origin URLs", () => { for (const APP_URL of ["javascript:bad", "not a url", "https://user:pass@example.com", "https://example.com/path"]) expect(() => readConfig({APP_URL})).toThrow(); });
  it("requires HTTPS for configured production authentication", () => { expect(() => readConfig({NODE_ENV:"production",NEXT_PUBLIC_SUPABASE_URL:"https://example.supabase.co",NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"placeholder"})).toThrow(); });
});
