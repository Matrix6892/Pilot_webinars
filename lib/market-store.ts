import { and, eq } from "drizzle-orm";
import demoData from "@/data/paint-demo.json";
import { ensureDb, getDb } from "@/db";
import { systemState } from "@/db/schema";
import {
  applySupplierMarketStockChange,
  supplierMarketFromState,
  supplierMarketStateValue,
  supplierMarketWithIds,
} from "@/lib/supplier-market.mjs";

const SUPPLIER_MARKET_STATE_KEY = "supplier-market-v1";
const MAX_UPDATE_ATTEMPTS = 3;

export type LiveMarketOffer = (typeof demoData.market)[number] & {
  id: string;
};

export type SupplierMarketUpdate =
  | {
      ok: true;
      market: LiveMarketOffer[];
      changed: { id: string; from: number; to: number };
    }
  | {
      ok: false;
      status: 404 | 409;
      code: "market_offer_not_found" | "market_update_conflict";
    };

function defaultMarket() {
  return supplierMarketWithIds(demoData.market) as LiveMarketOffer[];
}

function marketCheckedAt(now = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

function marketFromValue(value?: string | null) {
  return supplierMarketFromState(
    defaultMarket(),
    value,
  ) as LiveMarketOffer[];
}

export async function getLiveMarket(): Promise<LiveMarketOffer[]> {
  await ensureDb();
  const [saved] = await getDb()
    .select({ value: systemState.value })
    .from(systemState)
    .where(eq(systemState.key, SUPPLIER_MARKET_STATE_KEY))
    .limit(1);
  return marketFromValue(saved?.value);
}

export async function updateLiveMarketStock(
  id: string,
  stockKg: number,
): Promise<SupplierMarketUpdate> {
  await ensureDb();
  const db = getDb();

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const [saved] = await db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, SUPPLIER_MARKET_STATE_KEY))
      .limit(1);
    const market = marketFromValue(saved?.value);
    const update = applySupplierMarketStockChange(
      market,
      id,
      stockKg,
      marketCheckedAt(),
    );
    if (!update) {
      return {
        ok: false,
        status: 404,
        code: "market_offer_not_found",
      };
    }
    if (update.changed.from === update.changed.to) {
      return {
        ok: true,
        market: update.market as LiveMarketOffer[],
        changed: update.changed,
      };
    }

    const value = supplierMarketStateValue(update.market);
    const now = new Date().toISOString();
    if (!saved) {
      const inserted = await db
        .insert(systemState)
        .values({
          key: SUPPLIER_MARKET_STATE_KEY,
          value,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ key: systemState.key });
      if (inserted.length) {
        return {
          ok: true,
          market: update.market as LiveMarketOffer[],
          changed: update.changed,
        };
      }
      continue;
    }

    const updated = await db
      .update(systemState)
      .set({ value, updatedAt: now })
      .where(
        and(
          eq(systemState.key, SUPPLIER_MARKET_STATE_KEY),
          eq(systemState.value, saved.value),
        ),
      )
      .returning({ key: systemState.key });
    if (updated.length) {
      return {
        ok: true,
        market: update.market as LiveMarketOffer[],
        changed: update.changed,
      };
    }
  }

  return {
    ok: false,
    status: 409,
    code: "market_update_conflict",
  };
}
