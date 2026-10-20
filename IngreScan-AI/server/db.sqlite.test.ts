// Real integration test: runs the real server/db.ts functions against a real temporary SQLite file
// (migrated by the real migrator). Nothing is mocked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { createClient } from "@libsql/client";
import * as sqliteSchema from "../drizzle/schema.sqlite";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-sqlite-test-"));
const dbFile = path.join(tmpDir, "test.db");
const savedUrl = process.env.DATABASE_URL;
const savedPath = process.env.SQLITE_PATH;

let db: typeof import("./db");
let database: typeof import("./_core/database");

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.SQLITE_PATH = dbFile;
  database = await import("./_core/database");
  db = await import("./db");
});

afterAll(async () => {
  await database.closeDatabase();
  if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  if (savedPath === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = savedPath;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore EPERM / EBUSY lock errors on Windows
  }
});

async function newUser(openId: string) {
  await db.upsertUser({ openId, name: openId, email: `${openId}@example.com`, loginMethod: "local" });
  const user = await db.getUserByOpenId(openId);
  expect(user).toBeDefined();
  return user!;
}

describe("database configuration", () => {
  it("resolves dialect and path from the environment", () => {
    const { resolveDatabaseConfig } = database;
    expect(resolveDatabaseConfig({}).dialect).toBe("sqlite");
    expect((resolveDatabaseConfig({}) as any).path).toBe(path.resolve(process.cwd(), "data", "ingrescan.db"));
    expect((resolveDatabaseConfig({ SQLITE_PATH: "/x/y.db" }) as any).path).toBe("/x/y.db");
    expect((resolveDatabaseConfig({ DATABASE_URL: "file:/tmp/a.db" }) as any).path).toBe("/tmp/a.db");
    expect((resolveDatabaseConfig({ DATABASE_URL: "file:///tmp/a.db" }) as any).path).toBe("/tmp/a.db");
    expect((resolveDatabaseConfig({ DATABASE_URL: "sqlite:/tmp/b.db", SQLITE_PATH: "/ignored.db" }) as any).path).toBe("/tmp/b.db");
    expect(resolveDatabaseConfig({ DATABASE_URL: "mysql://u:p@h:3306/d" })).toEqual({ dialect: "mysql", url: "mysql://u:p@h:3306/d" });
  });

  it("creates and migrates the file on first use, and reopening an already-migrated file works", async () => {
    await db.getDb();
    expect(fs.existsSync(dbFile)).toBe(true);
    await newUser("reopen-check");
    await database.closeDatabase();
    // second start against the already-migrated file
    const again = await db.getUserByOpenId("reopen-check");
    expect(again?.openId).toBe("reopen-check");
  });

  it("migrated tables match the SQLite schema columns", async () => {
    const client = createClient({ url: `file:${dbFile}` });
    for (const value of Object.values(sqliteSchema)) {
      if (!is(value as any, SQLiteTable)) continue;
      const cfg = getTableConfig(value as any);
      const info = await client.execute(`PRAGMA table_info(\`${cfg.name}\`)`);
      const actual = info.rows.map(r => String(r.name)).sort();
      expect(actual).toEqual(cfg.columns.map(c => c.name).sort());
    }
    client.close();
  });

  it("the application connection enforces foreign keys (and ON DELETE CASCADE works through it)", async () => {
    await expect(db.addScanIngredient({ scanId: 987654, name: "orphan" })).rejects.toThrow();
    const ctx = await database.getDbContext();
    const rows = await (ctx!.db as any).run((await import("drizzle-orm")).sql`PRAGMA foreign_keys`);
    expect(Number(rows.rows[0].foreign_keys)).toBe(1);
  });

  it("enforces foreign keys", async () => {
    const client = createClient({ url: `file:${dbFile}` });
    await client.execute("PRAGMA foreign_keys = ON");
    await expect(
      client.execute("insert into scan_ingredients (scan_id, name) values (999999, 'orphan')")
    ).rejects.toThrow(/FOREIGN KEY/i);
    client.close();
  });
});

describe("users and profiles", () => {
  it("upsertUser inserts, then updates in place (one row)", async () => {
    await db.upsertUser({ openId: "u-upsert", name: "First", email: "a@example.com", loginMethod: "local" });
    const first = await db.getUserByOpenId("u-upsert");
    expect(first?.name).toBe("First");
    expect(first?.role).toBe("user");
    expect(first?.createdAt).toBeInstanceOf(Date);
    await db.upsertUser({ openId: "u-upsert", name: "Second" });
    const second = await db.getUserByOpenId("u-upsert");
    expect(second?.id).toBe(first?.id);
    expect(second?.name).toBe("Second");
    expect(second?.email).toBe("a@example.com");
    await db.upsertUser({ openId: "u-upsert", role: "admin", lastSignedIn: new Date() });
    expect((await db.getUserByOpenId("u-upsert"))?.role).toBe("admin");
  });

  it("upsertUser rejects a missing openId and getUserByOpenId returns undefined for unknown ids", async () => {
    await expect(db.upsertUser({} as any)).rejects.toThrow();
    expect(await db.getUserByOpenId("nobody")).toBeUndefined();
  });

  it("upsertUserProfile is atomic: calling twice leaves one row with the latest values", async () => {
    const u = await newUser("u-profile");
    expect(await db.getUserProfile(u.id)).toBeNull();
    const a = await db.upsertUserProfile({ userId: u.id, age: 30, height: 170, weight: 70, bmi: 24.2, gender: "female", dietType: "veg" });
    expect(a?.age).toBe(30);
    expect(a?.bmi).toBeCloseTo(24.2);
    const b = await db.upsertUserProfile({ userId: u.id, age: 31, exerciseFrequency: "moderate" });
    expect(b?.id).toBe(a?.id);
    expect(b?.age).toBe(31);
    expect(b?.exerciseFrequency).toBe("moderate");
    expect(b?.height).toBe(170);
    const concurrent = await Promise.all([
      db.upsertUserProfile({ userId: u.id, age: 40 }),
      db.upsertUserProfile({ userId: u.id, age: 41 }),
    ]);
    expect(concurrent).toHaveLength(2);
    const client = createClient({ url: `file:${dbFile}` });
    const count = await client.execute(`select count(*) as n from user_profiles where user_id = ${u.id}`);
    expect(Number(count.rows[0].n)).toBe(1);
    client.close();
  });
});

describe("medical conditions and medications", () => {
  it("medical conditions: add, list per user, delete only own", async () => {
    const u = await newUser("u-med1");
    const other = await newUser("u-med2");
    const r = await db.addMedicalCondition({ userId: u.id, condition: "Diabetes", diagnosedDate: new Date("2020-01-02T00:00:00Z"), notes: "type 2" });
    expect(r[0].insertId).toBeGreaterThan(0);
    const list = await db.getMedicalConditions(u.id);
    expect(list).toHaveLength(1);
    expect(list[0].condition).toBe("Diabetes");
    expect(list[0].diagnosedDate).toBeInstanceOf(Date);
    expect(list[0].diagnosedDate?.toISOString()).toBe("2020-01-02T00:00:00.000Z");
    await db.deleteMedicalCondition(list[0].id, other.id);
    expect(await db.getMedicalConditions(u.id)).toHaveLength(1);
    await db.deleteMedicalCondition(list[0].id, u.id);
    expect(await db.getMedicalConditions(u.id)).toHaveLength(0);
  });

  it("medications: add, boolean defaults, currentOnly filter, ordering, update, delete", async () => {
    const u = await newUser("u-meds");
    const other = await newUser("u-meds-other");
    await db.addMedication({ userId: u.id, name: "Old", startDate: new Date("2019-01-01T00:00:00Z"), isCurrent: false });
    await db.addMedication({ userId: u.id, name: "New", startDate: new Date("2023-01-01T00:00:00Z") });
    await db.addMedication({ userId: u.id, name: "NoDate" });
    const all = await db.getMedications(u.id);
    expect(all.map(m => m.name)).toEqual(["New", "Old", "NoDate"]);
    expect(all.find(m => m.name === "New")?.isCurrent).toBe(true);
    expect(all.find(m => m.name === "Old")?.isCurrent).toBe(false);
    const current = await db.getMedications(u.id, true);
    expect(current.map(m => m.name).sort()).toEqual(["New", "NoDate"]);

    const target = all.find(m => m.name === "New")!;
    await db.updateMedication(target.id, other.id, { name: "Hacked" });
    expect((await db.getMedications(u.id)).some(m => m.name === "Hacked")).toBe(false);
    await db.updateMedication(target.id, u.id, { dosage: "10mg", isCurrent: false });
    const updated = (await db.getMedications(u.id)).find(m => m.id === target.id)!;
    expect(updated.dosage).toBe("10mg");
    expect(updated.isCurrent).toBe(false);

    await db.deleteMedication(target.id, other.id);
    expect(await db.getMedications(u.id)).toHaveLength(3);
    await db.deleteMedication(target.id, u.id);
    expect(await db.getMedications(u.id)).toHaveLength(2);
  });
});

describe("food scans, ingredients, alternatives, chat", () => {
  it("createFoodScan returns the real insert id; ownership is enforced; defaults apply", async () => {
    const u = await newUser("u-scan1");
    const other = await newUser("u-scan2");
    const id1 = await db.createFoodScan({ userId: u.id, inputType: "text", productName: "Chips", rawIngredients: "salt" });
    const id2 = await db.createFoodScan({ userId: u.id, inputType: "text", productName: "Soda" });
    expect(typeof id1).toBe("number");
    expect(id2).toBe(id1 + 1);
    const scan = await db.getFoodScan(id1, u.id);
    expect(scan?.productName).toBe("Chips");
    expect(scan?.analysisComplete).toBe(false);
    expect(await db.getFoodScan(id1, other.id)).toBeUndefined();

    await db.updateFoodScan(id1, other.id, { riskScore: 99 });
    expect((await db.getFoodScan(id1, u.id))?.riskScore).toBeNull();
    await db.updateFoodScan(id1, u.id, { riskScore: 42, analysisComplete: true });
    const done = await db.getFoodScan(id1, u.id);
    expect(done?.riskScore).toBe(42);
    expect(done?.analysisComplete).toBe(true);
    expect(done?.updatedAt).toBeInstanceOf(Date);
  });

  it("getUserScans orders newest first (ties broken by id) and honors limit", async () => {
    const u = await newUser("u-scanlist");
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await db.createFoodScan({ userId: u.id, inputType: "text", productName: `P${i}` }));
    const all = await db.getUserScans(u.id);
    expect(all.map(s => s.id)).toEqual([...ids].reverse());
    const limited = await db.getUserScans(u.id, 2);
    expect(limited.map(s => s.id)).toEqual([ids[4], ids[3]]);
  });

  it("ingredients and alternatives: add, list, replace, and cascade on scan delete", async () => {
    const u = await newUser("u-ing");
    const scanId = await db.createFoodScan({ userId: u.id, inputType: "text" });
    await db.addScanIngredient({ scanId, name: "Sugar", riskLevel: "moderate", sources: JSON.stringify(["https://example.org"]) });
    await db.addScanIngredient({ scanId, name: "Salt", riskLevel: "low" });
    await db.addAlternative({ scanId, productName: "Fruit", reason: "No added sugar" });
    await db.addChatMessage({ userId: u.id, scanId, role: "user", content: "hello" });
    expect((await db.getScanIngredients(scanId)).map(i => i.name)).toEqual(["Sugar", "Salt"]);
    expect((await db.getAlternatives(scanId)).map(a => a.productName)).toEqual(["Fruit"]);

    await db.deleteScanIngredients(scanId);
    await db.deleteAlternatives(scanId);
    expect(await db.getScanIngredients(scanId)).toHaveLength(0);
    expect(await db.getAlternatives(scanId)).toHaveLength(0);

    await db.addScanIngredient({ scanId, name: "Palm oil", riskLevel: "high" });
    await db.addAlternative({ scanId, productName: "Nuts", reason: "Whole food" });
    expect(await db.getChatHistory(u.id, scanId)).toHaveLength(1);

    // Delete the scan row directly; foreign keys must cascade (matches MySQL ON DELETE CASCADE).
    const client = createClient({ url: `file:${dbFile}` });
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "delete from food_scans where id = ?", args: [scanId] });
    client.close();
    expect(await db.getScanIngredients(scanId)).toHaveLength(0);
    expect(await db.getAlternatives(scanId)).toHaveLength(0);
    expect(await db.getChatHistory(u.id, scanId)).toHaveLength(0);
  });

  it("chat history: oldest-first of the most recent N, scanId filtering, general conversation separate", async () => {
    const u = await newUser("u-chat");
    const scanId = await db.createFoodScan({ userId: u.id, inputType: "text" });
    for (let i = 1; i <= 5; i++) {
      await db.addChatMessage({ userId: u.id, role: i % 2 ? "user" : "assistant", content: `general ${i}` });
    }
    await db.addChatMessage({ userId: u.id, scanId, role: "user", content: "scan 1" });
    await db.addChatMessage({ userId: u.id, scanId, role: "assistant", content: "scan 2" });

    const general = await db.getChatHistory(u.id);
    expect(general.map(m => m.content)).toEqual(["general 1", "general 2", "general 3", "general 4", "general 5"]);
    const lastThree = await db.getChatHistory(u.id, undefined, 3);
    expect(lastThree.map(m => m.content)).toEqual(["general 3", "general 4", "general 5"]);
    const forScan = await db.getChatHistory(u.id, scanId);
    expect(forScan.map(m => m.content)).toEqual(["scan 1", "scan 2"]);
    expect(forScan[0].role).toBe("user");
    expect(await db.getChatHistory(u.id + 1000)).toEqual([]);
  });
});

describe("ingredient database", () => {
  it("upsertIngredient inserts then updates; lookup ignores case like MySQL", async () => {
    expect(await db.getIngredientByName("Aspartame")).toBeUndefined();
    await db.upsertIngredient({ name: "Aspartame", category: "sweetener", description: "v1" });
    await db.upsertIngredient({ name: "Aspartame", category: "sweetener", description: "v2" });
    await db.upsertIngredient({ name: "aspartame", description: "v3" });
    const found = await db.getIngredientByName("ASPARTAME");
    expect(found?.description).toBe("v3");
    const client = createClient({ url: `file:${dbFile}` });
    const count = await client.execute("select count(*) as n from ingredient_database where lower(name) = 'aspartame'");
    expect(Number(count.rows[0].n)).toBe(1);
    client.close();
  });
});

describe("food inventory", () => {
  it("CRUD with ownership, expiry ordering, id return", async () => {
    const u = await newUser("u-inv1");
    const other = await newUser("u-inv2");
    const late = await db.addInventoryItem({ userId: u.id, title: "Late", category: "dairy", expiryDate: new Date("2030-03-01T00:00:00Z") });
    const soon = await db.addInventoryItem({ userId: u.id, title: "Soon", category: "dairy", expiryDate: new Date("2030-01-01T00:00:00Z"), storageLocation: "freezer" });
    expect(late).toBeGreaterThan(0);
    const list = await db.getUserInventory(u.id);
    expect(list.map(i => i.title)).toEqual(["Soon", "Late"]);
    expect(list[0].storageLocation).toBe("freezer");
    expect(list[1].storageLocation).toBe("fridge");
    expect(list[1].status).toBe("fresh");
    expect(list[1].quantity).toBe("1");
    expect(list[0].expiryDate).toBeInstanceOf(Date);

    await db.updateInventoryItem(soon, other.id, { status: "consumed" });
    expect((await db.getUserInventory(u.id)).find(i => i.id === soon)?.status).toBe("fresh");
    await db.updateInventoryItem(soon, u.id, { status: "consumed" });
    expect((await db.getUserInventory(u.id)).find(i => i.id === soon)?.status).toBe("consumed");

    await db.deleteInventoryItem(late, other.id);
    expect(await db.getUserInventory(u.id)).toHaveLength(2);
    await db.deleteInventoryItem(late, u.id);
    expect(await db.getUserInventory(u.id)).toHaveLength(1);
  });
});

describe("FreshGuard produce", () => {
  const scan = (userId: number, n: number) => ({
    userId, fruitType: "apple", fruitName: `Apple ${n}`, freshness: "fresh" as const, freshnessLabel: "Fresh",
    pFresh: 0.91, confidence: 0.97, imageUrl: "/uploads/a.png",
  });

  it("produce scans: add, list newest first with limit, clear only own", async () => {
    const u = await newUser("u-prod1");
    const other = await newUser("u-prod2");
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(await db.addProduceScan(scan(u.id, i)));
    await db.addProduceScan(scan(other.id, 99));
    const list = await db.listProduceScans(u.id);
    expect(list.map(s => s.id)).toEqual([...ids].reverse());
    expect(list[0].pFresh).toBeCloseTo(0.91, 5);
    expect((await db.listProduceScans(u.id, 2)).map(s => s.id)).toEqual([ids[3], ids[2]]);
    await db.clearProduceScans(u.id);
    expect(await db.listProduceScans(u.id)).toHaveLength(0);
    expect(await db.listProduceScans(other.id)).toHaveLength(1);
  });

  it("produce inventory: add, list newest first, delete returns false for a non-owner", async () => {
    const u = await newUser("u-pinv1");
    const other = await newUser("u-pinv2");
    const item = (userId: number, name: string) => ({
      userId, name, fruitType: "banana", freshness: "normal" as const, pFresh: 0.5, confidence: 0.8,
      expiryDate: "2099-01-10", storageTip: "Keep cool",
    });
    const a = await db.addProduceInventoryItem(item(u.id, "A"));
    const b = await db.addProduceInventoryItem(item(u.id, "B"));
    expect(b).toBe(a + 1);
    const list = await db.listProduceInventory(u.id);
    expect(list.map(i => i.name)).toEqual(["B", "A"]);
    expect(list[0].expiryDate).toBe("2099-01-10");

    expect(await db.deleteProduceInventoryItem(a, other.id)).toBe(false);
    expect(await db.listProduceInventory(u.id)).toHaveLength(2);
    expect(await db.deleteProduceInventoryItem(a, u.id)).toBe(true);
    expect(await db.deleteProduceInventoryItem(a, u.id)).toBe(false);
    expect((await db.listProduceInventory(u.id)).map(i => i.name)).toEqual(["B"]);
  });
});
