import { inventoryWriteActor } from "@/lib/admin-auth";
import {
  getLiveMarket,
  updateLiveMarketStock,
} from "@/lib/market-store";
import {
  SUPPLIER_MARKET_MAX_STOCK_KG,
  SupplierMarketValidationError,
} from "@/lib/supplier-market.mjs";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store",
};

function errorResponse(status: number, error: string, code: string) {
  return Response.json(
    { error, code },
    { status, headers: noStoreHeaders },
  );
}

export async function GET() {
  return Response.json(
    { market: await getLiveMarket() },
    { headers: noStoreHeaders },
  );
}

export async function PATCH(request: Request) {
  const actor = await inventoryWriteActor(request);
  if (!actor) {
    return errorResponse(
      401,
      "Откройте пульт ведущего и повторите изменение.",
      "unauthorized",
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(
      400,
      "Обновите страницу и повторите действие.",
      "invalid_json",
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(
      400,
      "Обновите страницу и повторите действие.",
      "invalid_payload",
    );
  }

  const input = payload as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const stockKg = input.stockKg;
  if (!id) {
    return errorResponse(
      400,
      "Выберите предложение поставщика.",
      "invalid_market_offer_id",
    );
  }
  if (
    !Number.isSafeInteger(stockKg) ||
    Number(stockKg) < 0 ||
    Number(stockKg) > SUPPLIER_MARKET_MAX_STOCK_KG
  ) {
    return errorResponse(
      400,
      `Остаток поставщика должен быть целым числом от 0 до ${SUPPLIER_MARKET_MAX_STOCK_KG}.`,
      "invalid_stock_kg",
    );
  }

  try {
    const result = await updateLiveMarketStock(id, Number(stockKg));
    if (result.ok) {
      return Response.json(
        { market: result.market, changed: result.changed },
        { headers: noStoreHeaders },
      );
    }
    if (result.status === 404) {
      return errorResponse(
        404,
        "Предложение поставщика не найдено.",
        result.code,
      );
    }
    return errorResponse(
      409,
      "Предложение уже обновилось. Показываем свежие данные.",
      result.code,
    );
  } catch (error) {
    if (error instanceof SupplierMarketValidationError) {
      return errorResponse(400, error.message, "invalid_market_update");
    }
    throw error;
  }
}
