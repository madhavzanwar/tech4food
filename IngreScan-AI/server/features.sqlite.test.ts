// Real integration test: the real appRouter (called in-process like the WhatsApp runtime does) on a real
// temporary SQLite database. Nothing is mocked; no LLM key is configured, so offline paths are exercised.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-features-router-"));
const saved = { url: process.env.DATABASE_URL, sqlite: process.env.SQLITE_PATH, openai: process.env.OPENAI_API_KEY, forge: process.env.BUILT_IN_FORGE_API_KEY, tw: process.env.TWILIO_ACCOUNT_SID };

let appRouter: typeof import("./routers").appRouter;
let db: typeof import("./db");
let f: typeof import("./dbFeatures");
let database: typeof import("./_core/database");
let runtime: typeof import("./whatsappRuntime");
let config: typeof import("./whatsappConfig");

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.BUILT_IN_FORGE_API_KEY;
  process.env.SQLITE_PATH = path.join(tmpDir, "t.db");
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_WHATSAPP_FROM = "+14155238886";
  database = await import("./_core/database");
  db = await import("./db");
  f = await import("./dbFeatures");
  ({ appRouter } = await import("./routers"));
  runtime = await import("./whatsappRuntime");
  config = await import("./whatsappConfig");
}, 30000);

afterAll(async () => {
  await database.closeDatabase();
  for (const [k, v] of [["DATABASE_URL", saved.url], ["SQLITE_PATH", saved.sqlite], ["OPENAI_API_KEY", saved.openai], ["BUILT_IN_FORGE_API_KEY", saved.forge], ["TWILIO_ACCOUNT_SID", saved.tw]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore EPERM / EBUSY lock errors on Windows
  }
}, 30000);

async function user(openId: string) {
  await db.upsertUser({ openId, name: openId, loginMethod: "local" });
  const u = (await db.getUserByOpenId(openId))!;
  const caller = appRouter.createCaller({ user: u as any, req: { headers: {} } as any, res: {} as any });
  return { u, caller };
}
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("qc router (B2B batch grading)", () => {
  const photos = [
    { label: "crate-1.jpg", fruit: "apple", freshness: "fresh" as const, pFresh: 95, confidence: 99 },
    { label: "crate-2.jpg", fruit: "apple", freshness: "normal" as const, pFresh: 65, confidence: 90 },
    { label: "crate-3.jpg", fruit: "apple", freshness: "rotten" as const, pFresh: 5, confidence: 95 },
  ];

  it("stores the declared sample size and reproduces it in the reloaded summary and CSV", async () => {
    const a = await user("qc-sample");
    const res = await a.caller.qc.gradeBatch({ vendor: "Sample Co", sampleSize: 50, items: photos });
    const got = await a.caller.qc.get({ id: res.id });
    expect(got.batch.declaredSampleSize).toBe(50);
    expect(got.summary.declaredSampleSize).toBe(50);
    expect(got.summary.warnings.some((w) => w.includes("Declared sample size (50)"))).toBe(true);
    const csv = await a.caller.qc.csv({ id: res.id });
    expect(csv.csv).toContain("declared_sample_size");
    expect(csv.csv).toMatch(/declared_sample_size,50/);

    const none = await a.caller.qc.gradeBatch({ vendor: "No Sample", items: photos });
    expect((await a.caller.qc.get({ id: none.id })).batch.declaredSampleSize).toBeNull();
  });

  it("grades on the server from model outputs, stores the batch and keeps it private", async () => {
    const a = await user("qc-a");
    const b = await user("qc-b");
    const res = await a.caller.qc.gradeBatch({ vendor: "Green Farms", lotId: "L-7", items: photos });
    expect(res.summary.counts).toEqual({ A: 1, B: 1, REVIEW: 0, REJECT: 1 });
    expect(res.summary.photos.map((p) => p.grade)).toEqual(["A", "B", "REJECT"]);

    const list = await a.caller.qc.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ vendor: "Green Farms", total: 3, counts: { A: 1, B: 1, REVIEW: 0, REJECT: 1 } });

    const got = await a.caller.qc.get({ id: res.id });
    expect(got.items.map((i) => i.grade)).toEqual(["A", "B", "REJECT"]);
    expect(got.summary.verdict).toBe(res.summary.verdict);

    // another user sees nothing and cannot read, export or delete it
    expect(await b.caller.qc.list()).toHaveLength(0);
    await expect(b.caller.qc.get({ id: res.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.qc.csv({ id: res.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.qc.delete({ id: res.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const csv = await a.caller.qc.csv({ id: res.id });
    expect(csv.filename).toBe(`qc-batch-${res.id}.csv`);
    expect(csv.csv).toContain("Green Farms");
    const photoCsv = await a.caller.qc.csv({ id: res.id, kind: "photos" });
    expect(photoCsv.filename).toBe(`qc-batch-${res.id}-photos.csv`);
    const lines = photoCsv.csv.trim().split(/\r?\n/);
    expect(lines.length).toBe(4); // header + one row per photo
    expect(lines.slice(1).map((l) => l.split(",").includes("REJECT") || l.split(",").includes("A") || l.split(",").includes("B")).every(Boolean)).toBe(true);
    expect(photoCsv.csv).toContain("crate-3.jpg");
    const card = await a.caller.qc.scorecard();
    expect(card.vendors.map((v) => v.vendor)).toContain("Green Farms");

    await a.caller.qc.delete({ id: res.id });
    expect(await a.caller.qc.list()).toHaveLength(0);
  });

  it("rejects malformed input", async () => {
    const a = await user("qc-validate");
    await expect(a.caller.qc.gradeBatch({ vendor: "", items: photos })).rejects.toThrow();
    await expect(a.caller.qc.gradeBatch({ vendor: "V", items: [] })).rejects.toThrow();
    await expect(a.caller.qc.gradeBatch({ vendor: "V", items: [{ ...photos[0], pFresh: 140 }] })).rejects.toThrow();
    await expect(a.caller.qc.gradeBatch({ vendor: "V", items: Array.from({ length: 201 }, () => photos[0]) })).rejects.toThrow();
  });
});

describe("receipt router", () => {
  const text = ["Blinkit", "Amul Taaza Toned Milk 500ml   2 x 29.00   58.00", "Britannia Bread 400g  45.00", "Carry bag  5.00", "Total 108.00"].join("\n");

  it("parses pasted text with expiry suggestions, skips non-food, and imports after review", async () => {
    const a = await user("receipt-a");
    const parsed = await a.caller.receipt.parse({ text });
    expect(parsed.source).toBe("parser");
    expect(parsed.items.map((i) => i.name.toLowerCase())).toEqual(expect.arrayContaining([expect.stringContaining("milk"), expect.stringContaining("bread")]));
    expect(parsed.items.every((i) => i.suggestedExpiryDate === null || /^\d{4}-\d{2}-\d{2}$/.test(i.suggestedExpiryDate))).toBe(true);
    expect(parsed.skipped.length).toBeGreaterThan(0);
    expect(await a.caller.inventory.list()).toHaveLength(0); // parsing never saves

    const res = await a.caller.receipt.importItems({
      items: parsed.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, storageLocation: i.suggestedLocation, expiryDate: i.suggestedExpiryDate ?? ymd(3) })),
    });
    expect(res.imported).toBe(parsed.items.length);
    expect((await a.caller.inventory.list()).length).toBe(parsed.items.length);
  });

  it("imports nothing when one row is invalid (no partial receipt)", async () => {
    const a = await user("receipt-atomic");
    await expect(
      a.caller.receipt.importItems({
        items: [
          { name: "Milk", quantity: 1, unit: "l", category: "Dairy", storageLocation: "fridge", expiryDate: ymd(2) },
          { name: "Bad", quantity: 1, unit: "pcs", category: "Other", storageLocation: "pantry", expiryDate: "2099-13-45" },
        ],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await a.caller.inventory.list()).toHaveLength(0);
  });

  it("refuses receipt photos without a real AI key instead of inventing items", async () => {
    const a = await user("receipt-photo");
    await expect(a.caller.receipt.parse({ imageDataUrl: "data:image/png;base64,iVBORw0KGgo=" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(a.caller.receipt.parse({})).rejects.toThrow();
  });
});

describe("rescue and insights routers", () => {
  it("builds offline recipes from items about to expire, and none when nothing is urgent", async () => {
    const a = await user("rescue-a");
    expect((await a.caller.rescue.recipes({ windowDays: 3, utcOffsetMinutes: 0 })).recipes).toEqual([]);
    await a.caller.produce.addInventory({ name: "Banana", fruit: "banana", freshness: "normal", pFresh: 50, confidence: 95, imageUrl: "", expiryDate: ymd(1) });
    await a.caller.produce.addInventory({ name: "Tomato", fruit: "tomato", freshness: "normal", pFresh: 55, confidence: 95, imageUrl: "", expiryDate: ymd(2) });
    const out = await a.caller.rescue.recipes({ windowDays: 3, utcOffsetMinutes: 0 });
    expect(out.source).toBe("offline");
    expect(out.recipes.length).toBeGreaterThan(0);
    expect(out.recipes.every((r) => r.timeMinutes <= 15 && r.source === "offline")).toBe(true);
    expect(out.selection.urgent.map((i) => i.title).sort()).toEqual(["Banana", "Tomato"]);
  });

  it("does not suggest cooking with an item that is already past its date", async () => {
    const a = await user("rescue-old");
    await a.caller.produce.addInventory({ name: "Spinach", fruit: "spinach", freshness: "rotten", pFresh: 5, confidence: 90, imageUrl: "", expiryDate: ymd(-3) });
    const out = await a.caller.rescue.recipes({ windowDays: 3, utcOffsetMinutes: 0 });
    expect(out.recipes).toEqual([]);
    expect(out.selection.needsInspection.map((i) => i.title)).toContain("Spinach");
  });

  it("warns about ethylene producers stored with sensitive produce", async () => {
    const a = await user("ethylene-a");
    await a.caller.produce.addInventory({ name: "Apple", fruit: "apple", freshness: "fresh", pFresh: 90, confidence: 99, imageUrl: "", expiryDate: ymd(6) });
    await a.caller.produce.addInventory({ name: "Cucumber", fruit: "cucumber", freshness: "fresh", pFresh: 90, confidence: 99, imageUrl: "", expiryDate: ymd(6) });
    const out = await a.caller.insights.ethyleneAlerts();
    expect(out.alerts.length).toBeGreaterThan(0);
    expect(out.alerts[0].producer.name.toLowerCase()).toContain("apple");
  });

  it("computes personal health alerts for a scan, scoped to its owner", async () => {
    const a = await user("health-a");
    const b = await user("health-b");
    await a.caller.profile.addMedicalCondition({ condition: "Type 2 diabetes" });
    const { scanId } = await a.caller.scanner.createScan({ productName: "Sweet", inputType: "text", rawIngredients: "wheat flour, glucose syrup, maltodextrin" });
    await a.caller.analysis.analyzeIngredients({ scanId, ingredients: "wheat flour, glucose syrup, maltodextrin" });
    const out = await a.caller.insights.healthAlerts({ scanId });
    expect(out.hasProfile).toBe(true);
    expect(out.alerts.some((x) => /diabet/i.test(x.appliesTo))).toBe(true);
    expect(out.disclaimer.length).toBeGreaterThan(10);
    await expect(b.caller.insights.healthAlerts({ scanId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("profile region (used for local brand suggestions)", () => {
  it("saves, updates, clears and validates the region", async () => {
    const a = await user("region-a");
    expect((await a.caller.profile.upsert({ age: 30, region: "  India  " }))?.region).toBe("India");
    expect((await a.caller.profile.upsert({ age: 31 }))?.region).toBe("India"); // untouched when omitted
    expect((await a.caller.profile.upsert({ region: "Pune, India" }))?.region).toBe("Pune, India");
    expect((await a.caller.profile.upsert({ region: "" }))?.region).toBeNull(); // empty string clears
    await expect(a.caller.profile.upsert({ region: "x".repeat(65) })).rejects.toThrow();
  });
});

describe("WhatsApp link flow (real database, real router, real services)", () => {
  it("links a phone with a one-time code, rejects wrong/reused codes and exposes prefs", async () => {
    const a = await user("wa-link-a");
    expect((await a.caller.whatsapp.status()).configured).toBe(true);
    const { code } = await a.caller.whatsapp.createLinkCode();
    const services = runtime.createWhatsappServices({ env: config.getWhatsappEnv() });

    expect(await services.linkAccount("WRONGCODE", "+919800001111")).toEqual({ ok: false, reason: "invalid" });
    const ok = await services.linkAccount(code, "+919800001111");
    expect(ok).toMatchObject({ ok: true, userId: String(a.u.id) });
    expect(await services.linkAccount(code, "+919800002222")).toMatchObject({ ok: false }); // single use

    const st = await a.caller.whatsapp.status();
    expect(st).toMatchObject({ linked: true, timezone: "UTC", reminderHour: 9, remindersEnabled: true });
    expect(st.phoneMasked).not.toContain("98000011"); // masked in the UI

    await a.caller.whatsapp.updatePrefs({ timezone: "Asia/Kolkata", reminderHour: 7, remindersEnabled: false });
    expect(await services.getReminderPrefs(String(a.u.id))).toEqual({ enabled: false, hour: 7, timezone: "Asia/Kolkata" });
    await expect(a.caller.whatsapp.updatePrefs({ timezone: "Mars/Olympus" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.caller.whatsapp.updatePrefs({ reminderHour: 25 })).rejects.toThrow();

    // the bot reads the same pantry the website writes
    await a.caller.produce.addInventory({ name: "Apple", fruit: "apple", freshness: "fresh", pFresh: 90, confidence: 99, imageUrl: "", expiryDate: ymd(4) });
    const pantry = await services.listPantry(String(a.u.id));
    expect(pantry.map((p) => p.name)).toEqual(["Apple"]);
    await services.clearPantryItem(String(a.u.id), pantry[0].id);
    expect(await services.listPantry(String(a.u.id))).toHaveLength(0);
    await expect(services.clearPantryItem(String(a.u.id), pantry[0].id)).rejects.toThrow();

    expect((await a.caller.whatsapp.unlink()).success).toBe(true);
    expect((await a.caller.whatsapp.status()).linked).toBe(false);
  });

  it("an expired link code cannot be redeemed and creates no link", async () => {
    const a = await user("wa-link-expired");
    const { createLinkCode } = await import("./whatsapp/linking");
    const { code, record } = createLinkCode({ userId: String(a.u.id), now: Date.now() - 20 * 60_000 });
    await f.createWhatsappLinkCode(a.u.id, record.codeHash, record.salt, new Date(record.expiresAt));
    const services = runtime.createWhatsappServices({ env: config.getWhatsappEnv() });
    // expired codes are filtered out of the redeemable set, so they look invalid; the user can simply request a new code
    expect((await services.linkAccount(code, "+919800003333")).ok).toBe(false);
    expect(await f.getWhatsappLinkByPhone("+919800003333")).toBeNull();
  });

  it("refuses to create link codes when the bot is not configured", async () => {
    const a = await user("wa-unconfigured");
    const keep = process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_ACCOUNT_SID;
    try {
      await expect(a.caller.whatsapp.createLinkCode()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      process.env.TWILIO_ACCOUNT_SID = keep;
    }
  });
});
