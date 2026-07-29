import { isAdminRequest } from "@/lib/admin-auth";

export const ORDER_ACTION_KEY_HEADER = "x-order-key";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function digestsMatch(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function createOrderActionKey() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
}

export async function orderActionKeyHash(value: string) {
  return sha256(value.trim());
}

export async function canChangeOrder(
  request: Request,
  expectedHash: string | null,
) {
  if (await isAdminRequest(request)) return true;
  const actionKey = request.headers.get(ORDER_ACTION_KEY_HEADER)?.trim() ?? "";
  if (
    !expectedHash ||
    !/^[0-9a-f]{64}$/i.test(expectedHash) ||
    !/^[0-9a-f]{64}$/i.test(actionKey)
  ) {
    return false;
  }
  return digestsMatch(await orderActionKeyHash(actionKey), expectedHash);
}
