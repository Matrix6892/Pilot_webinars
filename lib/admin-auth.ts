import { env } from "cloudflare:workers";

export const ADMIN_COOKIE_NAME = "koler_admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

type SecretBindings = {
  KOLER_ADMIN_CODE?: string;
  SHEETS_SYNC_TOKEN?: string;
};

function bindings() {
  return env as unknown as SecretBindings;
}

function configuredAdminCode() {
  return bindings().KOLER_ADMIN_CODE?.trim() ?? "";
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function secretsMatch(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  const [leftDigest, rightDigest] = await Promise.all([
    sha256(left),
    sha256(right),
  ]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest.charCodeAt(index) ^ rightDigest.charCodeAt(index);
  }
  return difference === 0;
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const candidateName = part.slice(0, separator).trim();
    if (candidateName !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export function isAdminAuthConfigured() {
  return Boolean(configuredAdminCode());
}

export async function verifyAdminCode(candidate: string) {
  const expected = configuredAdminCode();
  return Boolean(expected) && secretsMatch(candidate.trim(), expected);
}

export async function adminSessionValue() {
  const code = configuredAdminCode();
  if (!code) return "";
  const expiresAt =
    Math.floor(Date.now() / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS;
  return `${expiresAt}.${await sha256(`${expiresAt}:${code}`)}`;
}

export function adminSessionCookie(value: string) {
  const expiresAt = Number(value.split(".")[0]);
  const expires = new Date(
    Number.isSafeInteger(expiresAt)
      ? expiresAt * 1000
      : Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
  ).toUTCString();
  return [
    `${ADMIN_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`,
    `Expires=${expires}`,
  ].join("; ");
}

export function expiredAdminSessionCookie() {
  return [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export async function isAdminRequest(request: Request) {
  const actual = cookieValue(request, ADMIN_COOKIE_NAME);
  const [expiresText, signature, ...rest] = actual.split(".");
  const expiresAt = Number(expiresText);
  const now = Math.floor(Date.now() / 1000);
  if (
    rest.length > 0 ||
    !/^\d{10}$/.test(expiresText ?? "") ||
    !/^[0-9a-f]{64}$/i.test(signature ?? "") ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + ADMIN_SESSION_MAX_AGE_SECONDS + 60
  ) {
    return false;
  }
  const code = configuredAdminCode();
  if (!code) return false;
  const expected = await sha256(`${expiresAt}:${code}`);
  return secretsMatch(signature, expected);
}

async function hasSheetsSyncToken(request: Request) {
  const expected = bindings().SHEETS_SYNC_TOKEN?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!expected || !authorization.startsWith(prefix)) return false;
  const actual = authorization.slice(prefix.length).trim();
  return Boolean(actual) && secretsMatch(actual, expected);
}

export async function inventoryWriteActor(request: Request) {
  if (await isAdminRequest(request)) return "admin";
  if (await hasSheetsSyncToken(request)) return "sheets-sync";
  return null;
}
