import schemaSql from "../migrations/0001_init.sql";
import { type Env, HttpError } from "./util";

export interface Settings {
  site_name: string;
  min_prefix: number;
  max_prefix: number;
  allow_register: boolean;
  max_mailboxes: number;
  forward_to: string;
  cache_ttl: number;
}

const DEFAULTS: Record<keyof Settings, string> = {
  site_name: "MailBlink",
  min_prefix: "5",
  max_prefix: "32",
  allow_register: "1",
  max_mailboxes: "20",
  forward_to: "",
  cache_ttl: "10",
};

const BOOL_KEYS = new Set(["allow_register"]);
const INT_KEYS = new Set(["min_prefix", "max_prefix", "max_mailboxes", "cache_ttl"]);

// Per-isolate memory cache: settings/domains change rarely, so avoid one D1 read per request.
const CACHE_MS = 60_000;
let settingsCache: { at: number; value: Settings } | null = null;
let domainsCache: { at: number; value: { name: string; enabled: boolean }[] } | null = null;

export function invalidateCache() {
  settingsCache = null;
  domainsCache = null;
}

export async function getSettings(env: Env): Promise<Settings> {
  if (settingsCache && Date.now() - settingsCache.at < CACHE_MS) return settingsCache.value;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const raw: Record<string, string> = { ...DEFAULTS };
  for (const row of results) if (row.key in DEFAULTS) raw[row.key] = row.value;
  const value = {} as Record<string, unknown>;
  for (const [key, v] of Object.entries(raw)) {
    value[key] = BOOL_KEYS.has(key) ? v === "1" : INT_KEYS.has(key) ? Number.parseInt(v, 10) : v;
  }
  settingsCache = { at: Date.now(), value: value as unknown as Settings };
  return settingsCache.value;
}

export async function saveSettings(env: Env, patch: Partial<Record<keyof Settings, string | number | boolean>>) {
  const stmts: D1PreparedStatement[] = [];
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in DEFAULTS) || v === undefined) continue;
    const value = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(key, value),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  invalidateCache();
}

export async function getDomains(env: Env) {
  if (domainsCache && Date.now() - domainsCache.at < CACHE_MS) return domainsCache.value;
  const { results } = await env.DB.prepare("SELECT name, enabled FROM domains ORDER BY id").all<{
    name: string;
    enabled: number;
  }>();
  domainsCache = { at: Date.now(), value: results.map((r) => ({ name: r.name, enabled: r.enabled === 1 })) };
  return domainsCache.value;
}

export async function getEnabledDomains(env: Env): Promise<string[]> {
  return (await getDomains(env)).filter((d) => d.enabled).map((d) => d.name);
}

// The isolate cache may predate a domain just added in the admin panel on another isolate,
// so a miss is re-checked against D1 before the domain is rejected.
export async function isEnabledDomain(env: Env, domain: string): Promise<boolean> {
  if ((await getEnabledDomains(env)).includes(domain)) return true;
  domainsCache = null;
  return (await getEnabledDomains(env)).includes(domain);
}

let schemaReady = false;
export async function ensureSchema(env: Env) {
  if (schemaReady) return;
  await env.DB.exec(
    schemaSql
      .split("\n")
      .filter((l) => l.trim())
      .join("\n"),
  );
  schemaReady = true;
}

export function isMissingTable(err: unknown) {
  return err instanceof Error && /no such table/i.test(err.message);
}

export function getSecret(env: Env): string {
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!secret) throw new HttpError(500, "服务器未配置 ADMIN_PASSWORD / SESSION_SECRET");
  return secret;
}
