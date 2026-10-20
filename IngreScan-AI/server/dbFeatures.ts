/**
 * Database access for the WhatsApp bot, the unified pantry view and B2B quality-control batches.
 * Works on both dialects (MySQL / embedded SQLite) through the helpers in ./_core/database.
 */
import { and, desc, eq, gt, isNull, lt, ne, sql, inArray } from "drizzle-orm";
import { getHouseholdMemberUserIds } from "./dbHousehold";
import type { InsertQcBatch, InsertQcItem } from "../drizzle/schema";
import { affectedRows, getDbContext, insertedId, upsertRow, type DbContext } from "./_core/database";

async function ctxOrThrow(): Promise<DbContext> {
  const ctx = await getDbContext();
  if (!ctx) throw new Error("Database not available");
  return ctx;
}

/** True for unique-constraint violations on either dialect (driver error shapes differ). */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; errno?: number; message?: string; cause?: any };
  const parts = [e?.code, e?.cause?.code, e?.cause?.errno, e?.errno, e?.message, e?.cause?.message].filter(Boolean).join(" ");
  return /ER_DUP_ENTRY|SQLITE_CONSTRAINT|UNIQUE constraint|Duplicate entry|\b1062\b/i.test(parts);
}

export async function getUserById(id: number) {
  const { db, s } = await ctxOrThrow();
  const rows = await db.select().from(s.users).where(eq(s.users.id, id)).limit(1);
  return rows[0] ?? null;
}

// ===================================================================== WhatsApp

export const MAX_LINK_CODE_ATTEMPTS = 5;

/** Store a fresh link code for the user (any earlier unused code is invalidated). */
export async function createWhatsappLinkCode(userId: number, codeHash: string, salt: string, expiresAt: Date) {
  const { db, s } = await ctxOrThrow();
  await db.delete(s.whatsappLinkCodes).where(and(eq(s.whatsappLinkCodes.userId, userId), isNull(s.whatsappLinkCodes.usedAt)));
  await db.delete(s.whatsappLinkCodes).where(lt(s.whatsappLinkCodes.expiresAt, new Date(Date.now() - 24 * 3600_000)));
  await db.insert(s.whatsappLinkCodes).values({ userId, codeHash, salt, expiresAt });
}

/** Codes that can still be redeemed: unused, unexpired and under the attempt limit. */
export async function listRedeemableLinkCodes(now: Date = new Date()) {
  const { db, s } = await ctxOrThrow();
  return db
    .select()
    .from(s.whatsappLinkCodes)
    .where(and(isNull(s.whatsappLinkCodes.usedAt), gt(s.whatsappLinkCodes.expiresAt, now), lt(s.whatsappLinkCodes.attempts, MAX_LINK_CODE_ATTEMPTS)));
}

/** Count a failed redemption attempt against every live code (a guess cannot be tied to one code). */
/** Count a failed redemption attempt against a specific code when provided. */
export async function recordLinkCodeFailure(codeId?: number, now: Date = new Date()) {
  if (codeId === undefined) return;
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  await db
    .update(s.whatsappLinkCodes)
    .set({ attempts: sql`${s.whatsappLinkCodes.attempts} + 1` })
    .where(and(eq(s.whatsappLinkCodes.id, codeId), isNull(s.whatsappLinkCodes.usedAt), gt(s.whatsappLinkCodes.expiresAt, now)));
}

/** Single-use: true only for the one caller that wins the race. */
export async function consumeLinkCode(id: number, now: Date = new Date()): Promise<boolean> {
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  const result = await db
    .update(s.whatsappLinkCodes)
    .set({ usedAt: now })
    .where(and(eq(s.whatsappLinkCodes.id, id), isNull(s.whatsappLinkCodes.usedAt)));
  return affectedRows(ctx, result) > 0;
}

/** Link a phone to a user. One phone per user and one user per phone: older links for either are replaced. */
export async function linkWhatsappAccount(userId: number, phone: string, timezone = "UTC") {
  const { db, s } = await ctxOrThrow();
  await db.delete(s.whatsappLinks).where(eq(s.whatsappLinks.userId, userId));
  await db.delete(s.whatsappLinks).where(eq(s.whatsappLinks.phone, phone));
  await db.insert(s.whatsappLinks).values({ userId, phone, timezone, lastInboundAt: new Date() });
}

export async function getWhatsappLinkByPhone(phone: string) {
  const { db, s } = await ctxOrThrow();
  const rows = await db.select().from(s.whatsappLinks).where(eq(s.whatsappLinks.phone, phone)).limit(1);
  return rows[0] ?? null;
}

export async function getWhatsappLinkByUser(userId: number) {
  const { db, s } = await ctxOrThrow();
  const rows = await db.select().from(s.whatsappLinks).where(eq(s.whatsappLinks.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function unlinkWhatsapp(userId: number) {
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  const link = await getWhatsappLinkByUser(userId);
  const result = await db.delete(s.whatsappLinks).where(eq(s.whatsappLinks.userId, userId));
  if (link) await db.delete(s.whatsappState).where(eq(s.whatsappState.phone, link.phone));
  return affectedRows(ctx, result) > 0;
}

export async function updateWhatsappPrefsByUser(
  userId: number,
  prefs: { timezone?: string; reminderHour?: number; remindersEnabled?: boolean }
) {
  const { db, s } = await ctxOrThrow();
  const set: Record<string, unknown> = {};
  if (prefs.timezone !== undefined) set.timezone = prefs.timezone;
  if (prefs.reminderHour !== undefined) set.reminderHour = prefs.reminderHour;
  if (prefs.remindersEnabled !== undefined) set.remindersEnabled = prefs.remindersEnabled;
  if (Object.keys(set).length === 0) return;
  await db.update(s.whatsappLinks).set(set).where(eq(s.whatsappLinks.userId, userId));
}

export async function updateWhatsappPrefsByPhone(
  phone: string,
  prefs: { timezone?: string; reminderHour?: number; remindersEnabled?: boolean }
) {
  const { db, s } = await ctxOrThrow();
  const set: Record<string, unknown> = {};
  if (prefs.timezone !== undefined) set.timezone = prefs.timezone;
  if (prefs.reminderHour !== undefined) set.reminderHour = prefs.reminderHour;
  if (prefs.remindersEnabled !== undefined) set.remindersEnabled = prefs.remindersEnabled;
  if (Object.keys(set).length === 0) return;
  await db.update(s.whatsappLinks).set(set).where(eq(s.whatsappLinks.phone, phone));
}

export async function touchWhatsappInbound(phone: string, at: Date) {
  const { db, s } = await ctxOrThrow();
  await db.update(s.whatsappLinks).set({ lastInboundAt: at }).where(eq(s.whatsappLinks.phone, phone));
}

export async function markWhatsappReminded(phone: string, localDate: string) {
  const { db, s } = await ctxOrThrow();
  await db.update(s.whatsappLinks).set({ lastReminderLocalDate: localDate }).where(eq(s.whatsappLinks.phone, phone));
}

/**
 * Atomically record a webhook message id. Returns true when it was ALREADY seen (duplicate delivery).
 * Relies on the unique (provider, message_id) index, so concurrent duplicates cannot both win.
 */
export async function seenWhatsappMessage(provider: string, messageId: string): Promise<boolean> {
  const { db, s } = await ctxOrThrow();
  try {
    await db.insert(s.whatsappSeen).values({ provider, messageId });
  } catch (error) {
    if (isUniqueViolation(error)) return true;
    throw error;
  }
  // Housekeeping: drop ids older than two weeks now and then (providers retry for hours, not weeks).
  if (Math.random() < 0.02) {
    await db.delete(s.whatsappSeen).where(lt(s.whatsappSeen.createdAt, new Date(Date.now() - 14 * 24 * 3600_000)));
  }
  return false;
}

export async function getWhatsappConversationJson(phone: string): Promise<string | null> {
  const { db, s } = await ctxOrThrow();
  const rows = await db.select().from(s.whatsappState).where(eq(s.whatsappState.phone, phone)).limit(1);
  return rows[0]?.state ?? null;
}

export async function setWhatsappConversationJson(phone: string, stateJson: string | null) {
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  if (stateJson === null) {
    await db.delete(s.whatsappState).where(eq(s.whatsappState.phone, phone));
    return;
  }
  const now = new Date();
  await upsertRow(ctx, s.whatsappState, { phone, state: stateJson, updatedAt: now }, { state: stateJson, updatedAt: now }, "phone");
}

export async function listWhatsappReminderLinks() {
  const { db, s } = await ctxOrThrow();
  return db.select().from(s.whatsappLinks).where(eq(s.whatsappLinks.remindersEnabled, true));
}

// ============================================================== Unified pantry

export type PantryEntry = {
  /** "produce:<id>" or "packaged:<id>". */
  id: string;
  name: string;
  kind: "produce" | "packaged";
  /** Calendar date YYYY-MM-DD. */
  expiryDate: string;
  storageLocation: string | null;
};

function dateOnly(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

/** Active (not consumed) items from both pantries (packaged fridge tracker + FreshGuard produce). */
export async function listActivePantry(userId: number): Promise<PantryEntry[]> {
  const { db, s } = await ctxOrThrow();
  const memberIds = await getHouseholdMemberUserIds(userId);
  const foodUserCondition = memberIds.length > 1
    ? inArray(s.foodInventory.userId, memberIds)
    : eq(s.foodInventory.userId, userId);
  const produceUserCondition = memberIds.length > 1
    ? inArray(s.produceInventory.userId, memberIds)
    : eq(s.produceInventory.userId, userId);

  const [packaged, produce] = await Promise.all([
    db
      .select()
      .from(s.foodInventory)
      .where(and(foodUserCondition, ne(s.foodInventory.status, "consumed"))),
    db.select().from(s.produceInventory).where(produceUserCondition),
  ]);
  const rows: PantryEntry[] = [
    ...packaged.map((r) => ({
      id: `packaged:${r.id}`,
      name: r.title,
      kind: "packaged" as const,
      expiryDate: dateOnly(r.expiryDate),
      storageLocation: r.storageLocation ?? null,
    })),
    ...produce.map((r) => ({
      id: `produce:${r.id}`,
      name: r.name,
      kind: "produce" as const,
      expiryDate: r.expiryDate,
      storageLocation: null,
    })),
  ];
  return rows.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.name.localeCompare(b.name));
}

/** Mark an item consumed (packaged) or remove it (produce). Returns false when it is not the user's item. */
export async function clearPantryEntry(userId: number, compositeId: string): Promise<boolean> {
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  const match = /^(produce|packaged):(\d+)$/.exec(compositeId);
  if (!match) return false;
  const id = Number(match[2]);
  const memberIds = await getHouseholdMemberUserIds(userId);
  const foodUserCondition = memberIds.length > 1
    ? inArray(s.foodInventory.userId, memberIds)
    : eq(s.foodInventory.userId, userId);
  const produceUserCondition = memberIds.length > 1
    ? inArray(s.produceInventory.userId, memberIds)
    : eq(s.produceInventory.userId, userId);

  if (match[1] === "produce") {
    const result = await db.delete(s.produceInventory).where(and(eq(s.produceInventory.id, id), produceUserCondition));
    return affectedRows(ctx, result) > 0;
  }
  const result = await db
    .update(s.foodInventory)
    .set({ status: "consumed" })
    .where(and(eq(s.foodInventory.id, id), foodUserCondition));
  return affectedRows(ctx, result) > 0;
}

// ============================================================== B2B QC batches

export async function createQcBatch(batch: InsertQcBatch, items: Omit<InsertQcItem, "batchId">[]) {
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  const result = await db.insert(s.qcBatches).values(batch);
  const batchId = insertedId(ctx, result);
  try {
    if (items.length > 0) await db.insert(s.qcItems).values(items.map((i) => ({ ...i, batchId })));
  } catch (error) {
    await db.delete(s.qcBatches).where(eq(s.qcBatches.id, batchId)); // cascades to any partial items
    throw error;
  }
  return batchId;
}

export async function listQcBatches(userId: number, limit = 100) {
  const { db, s } = await ctxOrThrow();
  return db
    .select()
    .from(s.qcBatches)
    .where(eq(s.qcBatches.userId, userId))
    .orderBy(desc(s.qcBatches.createdAt), desc(s.qcBatches.id))
    .limit(limit);
}

export async function getQcBatchWithItems(userId: number, batchId: number) {
  const { db, s } = await ctxOrThrow();
  const rows = await db
    .select()
    .from(s.qcBatches)
    .where(and(eq(s.qcBatches.id, batchId), eq(s.qcBatches.userId, userId)))
    .limit(1);
  if (!rows[0]) return null;
  const items = await db.select().from(s.qcItems).where(eq(s.qcItems.batchId, batchId)).orderBy(s.qcItems.id);
  return { batch: rows[0], items };
}

export async function deleteQcBatch(userId: number, batchId: number): Promise<boolean> {
  const ctx = await ctxOrThrow();
  const { db, s } = ctx;
  const result = await db.delete(s.qcBatches).where(and(eq(s.qcBatches.id, batchId), eq(s.qcBatches.userId, userId)));
  return affectedRows(ctx, result) > 0;
}
