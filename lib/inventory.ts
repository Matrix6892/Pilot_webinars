import { asc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { ensureDb, getDb } from "@/db";
import { inventoryItems } from "@/db/schema";
import demoData from "@/data/paint-demo.json";
import { getLiveMarket } from "@/lib/market-store";

export const INVENTORY_MAX_STOCK_KG = 1_000_000;
export const INVENTORY_REASON_MAX_LENGTH = 180;

type InventoryRow = {
  sku: string;
  stockKg: number;
  revision: number;
  updatedAt: string;
};

type InventoryChangeRow = {
  id: number;
  sku: string;
  revision: number;
  beforeStockKg: number;
  afterStockKg: number;
  reason: string;
  actor: string;
  createdAt: string;
};

export type PublicInventoryItem = {
  sku: string;
  name: string;
  stockKg: number;
  revision: number;
  updatedAt: string;
};

export type InventoryUpdateInput = {
  sku: string;
  stockKg: number;
  expectedRevision: number;
  reason: string;
  actor: string;
};

export type InventoryUpdateResult =
  | {
      ok: true;
      item: PublicInventoryItem;
      change: InventoryChangeRow;
    }
  | {
      ok: false;
      status: 404;
      code: "inventory_item_not_found";
      current: null;
    }
  | {
      ok: false;
      status: 409;
      code: "inventory_revision_conflict";
      current: PublicInventoryItem;
    };

export class InventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

const catalogBySku = new Map(
  demoData.products.map((product) => [product.sku, product] as const),
);

function normalizedTimestamp(value: string) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

function publicItem(row: InventoryRow): PublicInventoryItem {
  return {
    sku: row.sku,
    name: catalogBySku.get(row.sku)?.name ?? row.sku,
    stockKg: row.stockKg,
    revision: row.revision,
    updatedAt: normalizedTimestamp(row.updatedAt),
  };
}

export function isInventorySku(value: string) {
  return catalogBySku.has(value);
}

export async function getDemoDataWithInventory() {
  await ensureDb();
  const [rows, market] = await Promise.all([
    getDb()
      .select()
      .from(inventoryItems)
      .orderBy(asc(inventoryItems.sku)),
    getLiveMarket(),
  ]);
  const bySku = new Map(rows.map((row) => [row.sku, row]));

  return {
    ...demoData,
    market,
    products: demoData.products.map((product) => {
      const live = bySku.get(product.sku);
      return {
        ...product,
        stockKg: live?.stockKg ?? product.stockKg,
        stockRevision: live?.revision ?? 1,
        stockUpdatedAt: live ? normalizedTimestamp(live.updatedAt) : "",
      };
    }),
  };
}

export async function getPublicInventory(): Promise<PublicInventoryItem[]> {
  const data = await getDemoDataWithInventory();
  return data.products.map((product) => ({
    sku: product.sku,
    name: product.name,
    stockKg: product.stockKg,
    revision: product.stockRevision,
    updatedAt: product.stockUpdatedAt,
  }));
}

function validateUpdate(input: InventoryUpdateInput) {
  const sku = input.sku.trim();
  const reason = input.reason.trim();
  const actor = input.actor.trim().slice(0, 80);

  if (!isInventorySku(sku)) {
    throw new InventoryValidationError("Выберите краску из списка.");
  }
  if (
    !Number.isSafeInteger(input.stockKg) ||
    input.stockKg < 0 ||
    input.stockKg > INVENTORY_MAX_STOCK_KG
  ) {
    throw new InventoryValidationError(
      `Остаток должен быть целым числом от 0 до ${INVENTORY_MAX_STOCK_KG}.`,
    );
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new InventoryValidationError(
      "Обновите страницу и повторите действие.",
    );
  }
  if (!reason || reason.length > INVENTORY_REASON_MAX_LENGTH) {
    throw new InventoryValidationError(
      `Коротко напишите, что изменилось на складе: до ${INVENTORY_REASON_MAX_LENGTH} знаков.`,
    );
  }
  if (!actor) {
    throw new InventoryValidationError(
      "Откройте пульт ведущего и повторите изменение.",
    );
  }

  return { sku, reason, actor };
}

export async function updateInventoryStock(
  input: InventoryUpdateInput,
): Promise<InventoryUpdateResult> {
  const { sku, reason, actor } = validateUpdate(input);
  await ensureDb();

  const nextRevision = input.expectedRevision + 1;
  const now = new Date().toISOString();

  const [changeResult, updateResult] = await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO inventory_changes (
          sku,
          revision,
          before_stock_kg,
          after_stock_kg,
          reason,
          actor,
          created_at
        )
        SELECT sku, ?, stock_kg, ?, ?, ?, ?
        FROM inventory_items
        WHERE sku = ? AND revision = ?
        RETURNING
          id,
          sku,
          revision,
          before_stock_kg AS beforeStockKg,
          after_stock_kg AS afterStockKg,
          reason,
          actor,
          created_at AS createdAt
      `,
    ).bind(
      nextRevision,
      input.stockKg,
      reason,
      actor,
      now,
      sku,
      input.expectedRevision,
    ),
    env.DB.prepare(
      `
        UPDATE inventory_items
        SET stock_kg = ?, revision = ?, updated_at = ?
        WHERE sku = ? AND revision = ?
        RETURNING
          sku,
          stock_kg AS stockKg,
          revision,
          updated_at AS updatedAt
      `,
    ).bind(
      input.stockKg,
      nextRevision,
      now,
      sku,
      input.expectedRevision,
    ),
  ]);

  const updated = (updateResult.results as InventoryRow[])[0];
  const change = (changeResult.results as InventoryChangeRow[])[0];
  if (updated && change) {
    return { ok: true, item: publicItem(updated), change };
  }

  const [current] = await getDb()
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.sku, sku))
    .limit(1);

  if (!current) {
    return {
      ok: false,
      status: 404,
      code: "inventory_item_not_found",
      current: null,
    };
  }

  return {
    ok: false,
    status: 409,
    code: "inventory_revision_conflict",
    current: publicItem(current),
  };
}
