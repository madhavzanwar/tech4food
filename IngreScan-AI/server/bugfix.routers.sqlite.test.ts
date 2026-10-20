// Regression tests for router/data-layer bugs. Real appRouter on a real temporary SQLite database;
// only the LLM transport is mocked (the router's parsing and persistence are the code under test).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn(), isRealLLMConfigured: () => false }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-bugfix-router-"));
const saved = { url: process.env.DATABASE_URL, sqlite: process.env.SQLITE_PATH };

let appRouter: typeof import("./routers").appRouter;
let db: typeof import("./db");
let database: typeof import("./_core/database");
let invokeLLM: any;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.SQLITE_PATH = path.join(tmpDir, "t.db");
  database = await import("./_core/database");
  db = await import("./db");
  ({ appRouter } = await import("./routers"));
  ({ invokeLLM } = (await import("./_core/llm")) as any);
});

afterAll(async () => {
  await database.closeDatabase();
  for (const [k, v] of [["DATABASE_URL", saved.url], ["SQLITE_PATH", saved.sqlite]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore EPERM / EBUSY lock errors on Windows
  }
});

beforeEach(() => invokeLLM.mockReset());

async function user(openId: string) {
  await db.upsertUser({ openId, name: openId, loginMethod: "local" });
  const u = (await db.getUserByOpenId(openId))!;
  return { u, caller: appRouter.createCaller({ user: u as any, req: { headers: {} } as any, res: {} as any }) };
}
const reply = (payload: unknown) => ({ choices: [{ message: { content: JSON.stringify(payload) } }] });
const ing = (name: string) => ({ name, scientificName: "", category: "x", riskLevel: "low", shortTermEffects: "a", longTermEffects: "b", sideEffects: "c", personalizedRisk: "d", sources: [] });

describe("profile.upsert BMI", () => {
  it("recomputes BMI when only the weight (or only the height) changes", async () => {
    const { caller } = await user("bf-bmi");
    const first = await caller.profile.upsert({ height: 170, weight: 70 });
    expect(first?.bmi).toBeCloseTo(24.2, 1);
    const heavier = await caller.profile.upsert({ weight: 90 });
    expect(heavier?.bmi).toBeCloseTo(31.1, 1);
    const taller = await caller.profile.upsert({ height: 180 });
    expect(taller?.bmi).toBeCloseTo(27.8, 1);
    // Unrelated edits keep the stored BMI.
    const older = await caller.profile.upsert({ age: 40 });
    expect(older?.bmi).toBeCloseTo(27.8, 1);
  });

  it("null clears stored profile values and the BMI that depended on them; undefined keeps them", async () => {
    const { caller } = await user("bf-clear");
    await caller.profile.upsert({ age: 30, gender: "female", height: 170, weight: 70, dietType: "vegan", exerciseFrequency: "light" });
    const kept = await caller.profile.upsert({ region: "India" });
    expect(kept).toMatchObject({ age: 30, gender: "female", height: 170, weight: 70, dietType: "vegan" });
    const cleared = await caller.profile.upsert({ age: null, gender: null, weight: null, dietType: null, exerciseFrequency: null });
    expect(cleared).toMatchObject({ age: null, gender: null, weight: null, dietType: null, exerciseFrequency: null, height: 170, bmi: null });
  });
});

describe("dates", () => {
  it("rejects medication / condition dates outside the MySQL TIMESTAMP range with BAD_REQUEST", async () => {
    const { caller } = await user("bf-med-dates");
    await expect(caller.profile.addMedication({ name: "X", isCurrent: true, startDate: new Date("1960-01-01") })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.profile.addMedication({ name: "X", isCurrent: true, endDate: new Date("2050-01-01") })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.profile.addMedicalCondition({ condition: "c", diagnosedDate: new Date("1900-01-01") })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.profile.addMedication({ name: "Ok", isCurrent: true, startDate: new Date("2020-01-01") })).resolves.toBeDefined();
  });

  it("rejects calendar-impossible expiry dates instead of silently rolling them over", async () => {
    const { caller } = await user("bf-ymd");
    const base = { name: "Apple", fruit: "apple", freshness: "fresh" as const, pFresh: 90, confidence: 90 };
    await expect(caller.produce.addInventory({ ...base, expiryDate: "2026-02-31" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.produce.addInventory({ ...base, expiryDate: "2026-02-28" })).resolves.toHaveProperty("id");
    await expect(
      caller.receipt.importItems({ items: [{ name: "Milk", quantity: 1, unit: "pcs", category: "Dairy", storageLocation: "fridge", expiryDate: "2026-04-31" }] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await caller.inventory.list()).toHaveLength(0);
  });
});

describe("LLM output handling", () => {
  it("accepts a bare JSON array from the model (the prompt asks for an array) for analysis and alternatives", async () => {
    const { caller } = await user("bf-bare");
    const scanId = await db.createFoodScan({ userId: (await db.getUserByOpenId("bf-bare"))!.id, inputType: "text", productName: "Chips" });
    invokeLLM.mockResolvedValueOnce(reply([ing("Salt"), ing("Palm oil")]));
    await caller.analysis.analyzeIngredients({ scanId, ingredients: "salt, palm oil" });
    expect((await caller.scanner.getScan({ scanId })).ingredients.map((i) => i.name)).toEqual(["Salt", "Palm oil"]);

    invokeLLM.mockResolvedValueOnce(reply([{ productName: "Baked chips", brand: "", reason: "less oil", scientificJustification: "", sources: [] }]));
    const alts = await caller.analysis.suggestAlternatives({ scanId, productName: "Chips" });
    expect(alts).toHaveLength(1);
  });

  it("concurrent re-analysis of the same scan does not duplicate ingredient rows", async () => {
    const { caller, u } = await user("bf-concurrent");
    const scanId = await db.createFoodScan({ userId: u.id, inputType: "text", productName: "Soda" });
    invokeLLM.mockImplementation(async () => reply({ ingredients: [ing("A"), ing("B"), ing("C")], overallRiskScore: 40, summary: "s" }));
    await Promise.all([1, 2, 3].map(() => caller.analysis.analyzeIngredients({ scanId, ingredients: "a, b, c" })));
    expect((await caller.scanner.getScan({ scanId })).ingredients).toHaveLength(3);
  });
});
