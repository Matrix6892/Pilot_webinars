import {
  adminSessionCookie,
  adminSessionValue,
  expiredAdminSessionCookie,
  isAdminAuthConfigured,
  isAdminRequest,
  verifyAdminCode,
} from "@/lib/admin-auth";
import { checkRequestLimits } from "@/lib/request-limit";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store",
};

export async function GET(request: Request) {
  return Response.json(
    { authenticated: await isAdminRequest(request) },
    { headers: noStoreHeaders },
  );
}

export async function POST(request: Request) {
  if (!isAdminAuthConfigured()) {
    return Response.json(
      {
        error: "Код ведущего ещё не настроен.",
        code: "admin_auth_not_configured",
      },
      { status: 503, headers: noStoreHeaders },
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 1_024) {
    return Response.json(
      {
        error: "Введите короткий код ведущего.",
        code: "admin_payload_too_large",
      },
      { status: 413, headers: noStoreHeaders },
    );
  }
  const limit = await checkRequestLimits(request, [
    {
      name: "admin-login-ten-minutes",
      max: 5,
      windowSeconds: 600,
      scope: "visitor",
    },
    {
      name: "admin-login-stand-ten-minutes",
      max: 40,
      windowSeconds: 600,
      scope: "stand",
    },
  ]);
  if (!limit.allowed) {
    return Response.json(
      {
        error:
          "Пульт получил несколько попыток входа. Подождите немного и введите код снова.",
        code: "admin_rate_limited",
      },
      {
        status: 429,
        headers: {
          ...noStoreHeaders,
          "Retry-After": String(limit.retryAfterSeconds),
        },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Обновите страницу и повторите действие.", code: "invalid_json" },
      { status: 400, headers: noStoreHeaders },
    );
  }

  const code =
    payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).code === "string"
      ? (payload as Record<string, string>).code
      : "";
  if (!code) {
    return Response.json(
      { error: "Введите код ведущего.", code: "admin_code_required" },
      { status: 400, headers: noStoreHeaders },
    );
  }
  if (!(await verifyAdminCode(code))) {
    return Response.json(
      {
        error: "Код не подошёл. Введите код ведущего ещё раз.",
        code: "invalid_admin_code",
      },
      { status: 401, headers: noStoreHeaders },
    );
  }

  const response = Response.json(
    { authenticated: true },
    { headers: noStoreHeaders },
  );
  response.headers.append(
    "Set-Cookie",
    adminSessionCookie(await adminSessionValue()),
  );
  return response;
}

export async function DELETE() {
  const response = Response.json(
    { authenticated: false },
    { headers: noStoreHeaders },
  );
  response.headers.append("Set-Cookie", expiredAdminSessionCookie());
  return response;
}
