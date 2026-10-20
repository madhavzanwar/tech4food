// Real integration test: real dbFeatures.ts against a real temporary SQLite file (real migrator). Nothing mocked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-features-test-"));
const dbFile = path.join(tmpDir, "test.db");
const savedUrl = process.env.DATABASE_URL;
const savedPath = process.env.SQLITE_PATH;

let db: typeof import("./db");
let f: typeof import("./dbFeatures");
let database: typeof import("./_core/database");

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.SQLITE_PATH = dbFile;
  database = await import("./_core/database");
  db = await import("./db");
  f = await import("./dbFeatures");
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
  await db.upsertUser({ openId, name: openId, loginMethod: "local" });
  return (await db.getUserByOpenId(openId))!;
}

describe("WhatsApp link codes", () => {
  it("redeems a code once, honours expiry and the attempt limit", async () => {
    const u = await newUser("wa-user-1");
    await f.createWhatsappLinkCode(u.id, "hash1", "salt1", new Date(Date.now() + 600_000));
    let live = await f.listRedeemableLinkCodes();
    expect(live.filter((c) => c.userId === u.id)).toHaveLength(1);

    // single use, even when two redemptions race
    const id = live.find((c) => c.userId === u.id)!.id;
    const [a, b] = await Promise.all([f.consumeLinkCode(id), f.consumeLinkCode(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await f.listRedeemableLinkCodes()).some((c) => c.id === id)).toBe(false);

    // a new code invalidates the previous unused one
    await f.createWhatsappLinkCode(u.id, "h2", "s2", new Date(Date.now() + 600_000));
    await f.createWhatsappLinkCode(u.id, "h3", "s3", new Date(Date.now() + 600_000));
    live = (await f.listRedeemableLinkCodes()).filter((c) => c.userId === u.id);
    expect(live.map((c) => c.codeHash)).toEqual(["h3"]);

    // expired codes are not redeemable
    await f.createWhatsappLinkCode(u.id, "h4", "s4", new Date(Date.now() - 1000));
    expect((await f.listRedeemableLinkCodes()).some((c) => c.codeHash === "h4")).toBe(false);

    // attempt limit
    await f.createWhatsappLinkCode(u.id, "h5", "s5", new Date(Date.now() + 600_000));
    const code5 = (await f.listRedeemableLinkCodes()).find((c) => c.codeHash === "h5")!;
    for (let i = 0; i < f.MAX_LINK_CODE_ATTEMPTS; i++) await f.recordLinkCodeFailure(code5.id);
    expect((await f.listRedeemableLinkCodes()).some((c) => c.codeHash === "h5")).toBe(false);
  });
});

describe("WhatsApp links", () => {
  it("keeps one phone per user and one user per phone; prefs and bookkeeping update", async () => {
    const a = await newUser("wa-a");
    const b = await newUser("wa-b");
    await f.linkWhatsappAccount(a.id, "+919800000001", "Asia/Kolkata");
    expect((await f.getWhatsappLinkByPhone("+919800000001"))?.userId).toBe(a.id);
    expect((await f.getWhatsappLinkByUser(a.id))?.timezone).toBe("Asia/Kolkata");

    // same phone claimed by another account replaces the old link
    await f.linkWhatsappAccount(b.id, "+919800000001");
    expect((await f.getWhatsappLinkByPhone("+919800000001"))?.userId).toBe(b.id);
    expect(await f.getWhatsappLinkByUser(a.id)).toBeNull();

    // a user switching numbers leaves only the new one
    await f.linkWhatsappAccount(b.id, "+919800000002");
    expect(await f.getWhatsappLinkByPhone("+919800000001")).toBeNull();

    await f.updateWhatsappPrefsByPhone("+919800000002", { reminderHour: 7, timezone: "Europe/London", remindersEnabled: false });
    const link = (await f.getWhatsappLinkByUser(b.id))!;
    expect(link).toMatchObject({ reminderHour: 7, timezone: "Europe/London", remindersEnabled: false });
    expect((await f.listWhatsappReminderLinks()).some((l) => l.userId === b.id)).toBe(false);
    await f.updateWhatsappPrefsByUser(b.id, { remindersEnabled: true });
    expect((await f.listWhatsappReminderLinks()).some((l) => l.userId === b.id)).toBe(true);

    await f.markWhatsappReminded("+919800000002", "2026-10-14");
    const at = new Date("2026-10-14T03:00:00Z");
    await f.touchWhatsappInbound("+919800000002", at);
    const after = (await f.getWhatsappLinkByUser(b.id))!;
    expect(after.lastReminderLocalDate).toBe("2026-10-14");
    expect(after.lastInboundAt?.getTime()).toBe(at.getTime());

    expect(await f.unlinkWhatsapp(b.id)).toBe(true);
    expect(await f.getWhatsappLinkByUser(b.id)).toBeNull();
    expect(await f.unlinkWhatsapp(b.id)).toBe(false);
  });

  it("detects duplicate webhook deliveries atomically", async () => {
    expect(await f.seenWhatsappMessage("twilio", "SM123")).toBe(false);
    expect(await f.seenWhatsappMessage("twilio", "SM123")).toBe(true);
    expect(await f.seenWhatsappMessage("meta", "SM123")).toBe(false); // ids are scoped per provider
    const results = await Promise.all(Array.from({ length: 8 }, () => f.seenWhatsappMessage("meta", "wamid.RACE")));
    expect(results.filter((seen) => !seen)).toHaveLength(1);
  });

  it("stores, replaces and clears conversation state", async () => {
    expect(await f.getWhatsappConversationJson("+911")).toBeNull();
    await f.setWhatsappConversationJson("+911", JSON.stringify({ kind: "browsing_pantry", nextPage: 1 }));
    await f.setWhatsappConversationJson("+911", JSON.stringify({ kind: "browsing_pantry", nextPage: 2 }));
    expect(JSON.parse((await f.getWhatsappConversationJson("+911"))!).nextPage).toBe(2);
    await f.setWhatsappConversationJson("+911", null);
    expect(await f.getWhatsappConversationJson("+911")).toBeNull();
  });
});

describe("unified pantry", () => {
  it("merges packaged and produce items, sorts by expiry and clears only the owner's items", async () => {
    const owner = await newUser("pantry-owner");
    const other = await newUser("pantry-other");
    await db.addInventoryItem({ userId: owner.id, title: "Milk", category: "Dairy", quantity: "1", storageLocation: "fridge", expiryDate: new Date("2099-01-05T00:00:00Z") });
    const consumedId = await db.addInventoryItem({ userId: owner.id, title: "Old Yogurt", category: "Dairy", quantity: "1", storageLocation: "fridge", expiryDate: new Date("2099-01-01T00:00:00Z"), status: "consumed" });
    expect(consumedId).toBeGreaterThan(0);
    const produceId = await db.addProduceInventoryItem({ userId: owner.id, name: "Apple", fruitType: "apple", freshness: "fresh", pFresh: 90, confidence: 99, expiryDate: "2099-01-03" });
    await db.addProduceInventoryItem({ userId: other.id, name: "Banana", fruitType: "banana", freshness: "fresh", pFresh: 90, confidence: 99, expiryDate: "2099-01-02" });

    const items = await f.listActivePantry(owner.id);
    expect(items.map((i) => i.name)).toEqual(["Apple", "Milk"]); // consumed hidden, other user's hidden, sorted by date
    expect(items[0]).toMatchObject({ kind: "produce", expiryDate: "2099-01-03", id: `produce:${produceId}` });
    expect(items[1]).toMatchObject({ kind: "packaged", expiryDate: "2099-01-05" });

    // another user cannot clear it; malformed ids are rejected
    expect(await f.clearPantryEntry(other.id, items[0].id)).toBe(false);
    expect(await f.clearPantryEntry(owner.id, "produce:abc")).toBe(false);
    expect(await f.clearPantryEntry(owner.id, "drop table")).toBe(false);
    expect(await f.clearPantryEntry(owner.id, items[0].id)).toBe(true);
    expect(await f.clearPantryEntry(owner.id, items[1].id)).toBe(true); // packaged -> consumed
    expect(await f.listActivePantry(owner.id)).toHaveLength(0);
  });
});

describe("QC batches", () => {
  it("creates a batch with items, scopes reads to the owner and cascades on delete", async () => {
    const u = await newUser("qc-owner");
    const o = await newUser("qc-other");
    const id = await f.createQcBatch(
      { userId: u.id, vendor: "Green Farms", lotId: "L-1", verdict: "ACCEPT", total: 2, gradeA: 1, gradeB: 1, meanPFresh: 82.5 },
      [
        { label: "crate1.jpg", fruitType: "apple", freshness: "fresh", pFresh: 95, confidence: 99, grade: "A", reasons: "[]" },
        { label: "crate2.jpg", fruitType: "apple", freshness: "normal", pFresh: 70, confidence: 90, grade: "B", reasons: "[]" },
      ]
    );
    expect((await f.listQcBatches(u.id)).map((b) => b.vendor)).toEqual(["Green Farms"]);
    expect(await f.listQcBatches(o.id)).toHaveLength(0);
    const full = await f.getQcBatchWithItems(u.id, id);
    expect(full?.items).toHaveLength(2);
    expect(await f.getQcBatchWithItems(o.id, id)).toBeNull();
    expect(await f.deleteQcBatch(o.id, id)).toBe(false);
    expect(await f.deleteQcBatch(u.id, id)).toBe(true);
    expect(await f.getQcBatchWithItems(u.id, id)).toBeNull();
    // items were removed with the batch (foreign key cascade)
    const ctx = (await database.getDbContext())!;
    const left = await (ctx.db as any).select().from(ctx.s.qcItems);
    expect(left.some((r: any) => r.batchId === id)).toBe(false);
  });

  it("rolls back the batch when item insertion fails", async () => {
    const u = await newUser("qc-rollback");
    await expect(
      f.createQcBatch(
        { userId: u.id, vendor: "Bad Vendor", verdict: "ACCEPT", total: 1, meanPFresh: 50 },
        [{ label: "x", fruitType: null as any, freshness: "fresh", pFresh: 1, confidence: 1, grade: "A" }]
      )
    ).rejects.toThrow();
    expect((await f.listQcBatches(u.id)).some((b) => b.vendor === "Bad Vendor")).toBe(false);
  });
});
