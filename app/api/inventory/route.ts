import { inventoryWriteActor } from "@/lib/admin-auth";
import {
  getPublicInventory,
  INVENTORY_MAX_STOCK_KG,
  INVENTORY_REASON_MAX_LENGTH,
  InventoryValidationError,
  isInventorySku,
  updateInventoryStock,
} from "@/lib/inventory";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store",
};

function errorResponse(
  status: number,
  error: string,
  code: string,
  details?: Record<string, unknown>,
) {
  return Response.json(
    { error, code, ...details },
    { status, headers: noStoreHeaders },
  );
}

export async function GET() {
  return Response.json(
    { items: await getPublicInventory() },
    { headers: noStoreHeaders },
  );
}

export async function PATCH(request: Request) {
  const actor = await inventoryWriteActor(request);
  if (!actor) {
    return errorResponse(
      401,
      "Откройте панель администратора и повторите изменение.",
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
  const sku = typeof input.sku === "string" ? input.sku.trim() : "";
  const stockKg = input.stockKg;
  const expectedRevision = input.expectedRevision;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";

  if (!sku || !isInventorySku(sku)) {
    return errorResponse(400, "Выберите краску из списка.", "invalid_sku");
  }
  if (
    !Number.isSafeInteger(stockKg) ||
    Number(stockKg) < 0 ||
    Number(stockKg) > INVENTORY_MAX_STOCK_KG
  ) {
    return errorResponse(
      400,
      `Остаток должен быть целым числом от 0 до ${INVENTORY_MAX_STOCK_KG}.`,
      "invalid_stock_kg",
    );
  }
  if (
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 1 ||
    Number(expectedRevision) >= Number.MAX_SAFE_INTEGER
  ) {
    return errorResponse(
      400,
      "Обновите страницу и повторите действие.",
      "invalid_expected_revision",
    );
  }
  if (!reason || reason.length > INVENTORY_REASON_MAX_LENGTH) {
    return errorResponse(
      400,
      `Коротко напишите, что изменилось на складе: до ${INVENTORY_REASON_MAX_LENGTH} знаков.`,
      "invalid_reason",
    );
  }

  try {
    const result = await updateInventoryStock({
      sku,
      stockKg: Number(stockKg),
      expectedRevision: Number(expectedRevision),
      reason,
      actor,
    });
    if (result.ok) {
      return Response.json(
        { item: result.item, change: result.change },
        { headers: noStoreHeaders },
      );
    }
    if (result.status === 409) {
      return errorResponse(
        409,
        "Склад уже обновился. Показываем свежие данные.",
        result.code,
        { current: result.current },
      );
    }
    return errorResponse(
      404,
      "Выберите краску из списка.",
      result.code,
    );
  } catch (error) {
    if (error instanceof InventoryValidationError) {
      return errorResponse(400, error.message, "invalid_inventory_update");
    }
    throw error;
  }
}
