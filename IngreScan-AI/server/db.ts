import { eq, desc, and, isNull } from "drizzle-orm";
import type {
  InsertUser,
  InsertUserProfile,
  InsertMedicalCondition,
  InsertMedication,
  InsertFoodScan,
  InsertScanIngredient,
  InsertAlternative,
  InsertChatMessage,
  InsertIngredientData,
  InsertFoodInventoryItem,
  InsertProduceScan,
  InsertProduceInventoryItem,
  produceInventory,
  produceScans,
} from "../drizzle/schema";
import {
  getDbContext,
  insertedId,
  affectedRows,
  writeResult,
  upsertRow,
  eqInsensitive,
  type DbContext,
} from "./_core/database";
import { ENV } from './_core/env';

export type ProduceInventoryRow = typeof produceInventory.$inferSelect;
export type ProduceScanRow = typeof produceScans.$inferSelect;

/**
 * Active database (MySQL when DATABASE_URL is mysql://, embedded SQLite otherwise), or null if a MySQL
 * connection could not be created. All functions below work on both dialects; see ./_core/database.ts.
 */
export async function getDb() {
  return (await getDbContext())?.db ?? null;
}

async function getCtx(): Promise<DbContext | null> {
  return getDbContext();
}

// ============= User Management =============

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const ctx = await getCtx();
  if (!ctx) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  const { db, s } = ctx;

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    // MySQL refreshes updatedAt itself (ON UPDATE CURRENT_TIMESTAMP); SQLite needs it set explicitly.
    if (ctx.dialect === "sqlite") updateSet.updatedAt = new Date();

    await upsertRow(ctx, s.users, values, updateSet, "openId");
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const ctx = await getCtx();
  if (!ctx) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }
  const { db, s } = ctx;

  const result = await db.select().from(s.users).where(eq(s.users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============= User Profile =============

export async function getUserProfile(userId: number) {
  const ctx = await getCtx();
  if (!ctx) return null;
  const { db, s } = ctx;
  const result = await db.select().from(s.userProfiles).where(eq(s.userProfiles.userId, userId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function upsertUserProfile(profile: InsertUserProfile) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  // Atomic thanks to the unique index on user_profiles.user_id.
  const { userId: _userId, ...updates } = profile;
  await upsertRow(ctx, s.userProfiles, profile, { ...updates, updatedAt: new Date() }, "userId");

  return getUserProfile(profile.userId);
}

// ============= Medical Conditions =============

export async function getMedicalConditions(userId: number) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.medicalConditions).where(eq(s.medicalConditions.userId, userId));
}

export async function addMedicalCondition(condition: InsertMedicalCondition) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.medicalConditions).values(condition);
  return writeResult(ctx, result);
}

export async function deleteMedicalCondition(id: number, userId: number): Promise<number> {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.delete(s.medicalConditions).where(
    and(eq(s.medicalConditions.id, id), eq(s.medicalConditions.userId, userId))
  );
  return affectedRows(ctx, result);
}

// ============= Medications =============

export async function getMedications(userId: number, currentOnly: boolean = false) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  const conditions = currentOnly 
    ? and(eq(s.medications.userId, userId), eq(s.medications.isCurrent, true))
    : eq(s.medications.userId, userId);
  
  return db.select().from(s.medications).where(conditions).orderBy(desc(s.medications.startDate), desc(s.medications.id));
}

export async function addMedication(medication: InsertMedication) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.medications).values(medication);
  return writeResult(ctx, result);
}

export async function updateMedication(id: number, userId: number, updates: Partial<InsertMedication>): Promise<number> {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.update(s.medications)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(s.medications.id, id), eq(s.medications.userId, userId)));
  return affectedRows(ctx, result);
}

export async function deleteMedication(id: number, userId: number): Promise<number> {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.delete(s.medications).where(
    and(eq(s.medications.id, id), eq(s.medications.userId, userId))
  );
  return affectedRows(ctx, result);
}

// ============= Food Scans =============

export async function createFoodScan(scan: InsertFoodScan) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.foodScans).values(scan);
  // Use the actual insert id (selecting "latest by createdAt" is racy and has 1s resolution)
  return insertedId(ctx, result);
}

export async function getFoodScan(scanId: number, userId: number) {
  const ctx = await getCtx();
  if (!ctx) return undefined;
  const { db, s } = ctx;
  const result = await db.select().from(s.foodScans).where(
    and(eq(s.foodScans.id, scanId), eq(s.foodScans.userId, userId))
  ).limit(1);
  
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserScans(userId: number, limit: number = 50) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.foodScans)
    .where(eq(s.foodScans.userId, userId))
    .orderBy(desc(s.foodScans.createdAt), desc(s.foodScans.id))
    .limit(limit);
}

export async function updateFoodScan(scanId: number, userId: number, updates: Partial<InsertFoodScan>) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  await db.update(s.foodScans)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(s.foodScans.id, scanId), eq(s.foodScans.userId, userId)));
}

export async function deleteFoodScan(scanId: number, userId: number) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  await db.delete(s.foodScans)
    .where(and(eq(s.foodScans.id, scanId), eq(s.foodScans.userId, userId)));
}

// ============= Scan Ingredients =============

export async function addScanIngredient(ingredient: InsertScanIngredient) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.scanIngredients).values(ingredient);
  return writeResult(ctx, result);
}

export async function deleteScanIngredients(scanId: number) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  await db.delete(s.scanIngredients).where(eq(s.scanIngredients.scanId, scanId));
}

export async function getScanIngredients(scanId: number) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.scanIngredients).where(eq(s.scanIngredients.scanId, scanId));
}

// ============= Alternatives =============

export async function addAlternative(alternative: InsertAlternative) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.alternatives).values(alternative);
  return writeResult(ctx, result);
}

export async function deleteAlternatives(scanId: number) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  await db.delete(s.alternatives).where(eq(s.alternatives.scanId, scanId));
}

export async function getAlternatives(scanId: number) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.alternatives).where(eq(s.alternatives.scanId, scanId));
}

// ============= Chat Messages =============

export async function addChatMessage(message: InsertChatMessage) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.chatMessages).values(message);
  return writeResult(ctx, result);
}

export async function getChatHistory(userId: number, scanId?: number, limit: number = 100) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  // Without a scanId, only the general (non-scan) conversation is returned.
  const conditions = scanId !== undefined
    ? and(eq(s.chatMessages.userId, userId), eq(s.chatMessages.scanId, scanId))
    : and(eq(s.chatMessages.userId, userId), isNull(s.chatMessages.scanId));
  
  // Take the most recent `limit` messages, then return them oldest-first.
  const rows = await db.select().from(s.chatMessages)
    .where(conditions)
    .orderBy(desc(s.chatMessages.createdAt), desc(s.chatMessages.id))
    .limit(limit);
  return rows.reverse();
}

// ============= Ingredient Database =============

export async function getIngredientByName(name: string) {
  const ctx = await getCtx();
  if (!ctx) return undefined;
  const { db, s } = ctx;
  const result = await db.select().from(s.ingredientDatabase)
    .where(eqInsensitive(ctx, s.ingredientDatabase.name, name))
    .limit(1);
  
  return result.length > 0 ? result[0] : undefined;
}

export async function upsertIngredient(ingredient: InsertIngredientData) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const set = { ...ingredient, lastUpdated: new Date() };
  if (ctx.dialect === "sqlite") {
    // MySQL's default collation makes the unique name case-insensitive; mimic that on SQLite.
    const existing = await db.select({ id: s.ingredientDatabase.id }).from(s.ingredientDatabase)
      .where(eqInsensitive(ctx, s.ingredientDatabase.name, ingredient.name))
      .limit(1);
    if (existing.length > 0) {
      const { name: _name, ...rest } = set;
      await db.update(s.ingredientDatabase).set(rest).where(eq(s.ingredientDatabase.id, existing[0].id));
      return;
    }
  }
  await upsertRow(ctx, s.ingredientDatabase, ingredient, set, "name");
}

// ============= Food Expiry Tracker Inventory =============

export async function getUserInventory(userId: number) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.foodInventory)
    .where(eq(s.foodInventory.userId, userId))
    .orderBy(s.foodInventory.expiryDate, s.foodInventory.id);
}

export async function addInventoryItem(item: InsertFoodInventoryItem) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.foodInventory).values(item);
  return insertedId(ctx, result);
}

export async function updateInventoryItem(
  id: number,
  userId: number,
  updates: Partial<InsertFoodInventoryItem>
): Promise<number> {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.update(s.foodInventory)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(s.foodInventory.id, id), eq(s.foodInventory.userId, userId)));
  return affectedRows(ctx, result);
}

export async function deleteInventoryItem(id: number, userId: number): Promise<number> {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.delete(s.foodInventory)
    .where(and(eq(s.foodInventory.id, id), eq(s.foodInventory.userId, userId)));
  return affectedRows(ctx, result);
}

// ============= FreshGuard produce (per-user pantry + history) =============

export async function listProduceScans(userId: number, limit = 50) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.produceScans)
    .where(eq(s.produceScans.userId, userId))
    .orderBy(desc(s.produceScans.createdAt), desc(s.produceScans.id))
    .limit(limit);
}

export async function addProduceScan(scan: InsertProduceScan) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.produceScans).values(scan);
  return insertedId(ctx, result);
}

export async function clearProduceScans(userId: number) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  await db.delete(s.produceScans).where(eq(s.produceScans.userId, userId));
}

export async function listProduceInventory(userId: number) {
  const ctx = await getCtx();
  if (!ctx) return [];
  const { db, s } = ctx;
  return db.select().from(s.produceInventory)
    .where(eq(s.produceInventory.userId, userId))
    .orderBy(desc(s.produceInventory.id));
}

export async function addProduceInventoryItem(item: InsertProduceInventoryItem) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.insert(s.produceInventory).values(item);
  return insertedId(ctx, result);
}

/** Returns true when a row owned by this user was deleted. */
export async function deleteProduceInventoryItem(id: number, userId: number) {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;
  const result = await db.delete(s.produceInventory)
    .where(and(eq(s.produceInventory.id, id), eq(s.produceInventory.userId, userId)));
  return affectedRows(ctx, result) > 0;
}
