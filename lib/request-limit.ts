import { env } from "cloudflare:workers";
import { ensureDb } from "@/db";

type LimitRule = {
  name: string;
  max: number;
  windowSeconds: number;
  scope: "visitor" | "stand";
};

type LimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function visitorFingerprint(request: Request) {
  const forwarded =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  const userAgent = request.headers.get("user-agent")?.slice(0, 160) ?? "";
  return (await sha256(`${forwarded}|${userAgent}`)).slice(0, 24);
}

async function increment(key: string, now: string) {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  const row = await binding
    .prepare(
      `INSERT INTO system_state ("key", "value", "updated_at")
       VALUES (?1, '1', ?2)
       ON CONFLICT("key") DO UPDATE SET
         "value" = CAST("value" AS INTEGER) + 1,
         "updated_at" = ?2
       RETURNING "value"`,
    )
    .bind(key, now)
    .first<{ value: string }>();
  return Number(row?.value ?? 1);
}

export async function checkRequestLimits(
  request: Request,
  rules: LimitRule[],
): Promise<LimitResult> {
  await ensureDb();
  const now = new Date();
  const fingerprint = await visitorFingerprint(request);

  for (const rule of rules) {
    const window = Math.floor(now.getTime() / 1000 / rule.windowSeconds);
    const identity = rule.scope === "visitor" ? fingerprint : "all";
    const key = `limit:${rule.name}:${identity}:${window}`;
    const count = await increment(key, now.toISOString());
    if (count > rule.max) {
      const elapsed = Math.floor(now.getTime() / 1000) % rule.windowSeconds;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, rule.windowSeconds - elapsed),
      };
    }
  }

  return { allowed: true };
}
