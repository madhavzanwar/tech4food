import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  getFoodScan: vi.fn(),
  getScanIngredients: vi.fn(async () => [{ name: "SECRET-INGREDIENT" }]),
  getAlternatives: vi.fn(async () => []),
  getUserProfile: vi.fn(async () => null),
  getMedicalConditions: vi.fn(async () => []),
  getMedications: vi.fn(async () => []),
  addChatMessage: vi.fn(),
  getChatHistory: vi.fn(async () => []),
  deleteScanIngredients: vi.fn(),
  addScanIngredient: vi.fn(),
  updateFoodScan: vi.fn(),
  updateMedication: vi.fn(async () => 1),
  deleteMedication: vi.fn(async () => 1),
  deleteMedicalCondition: vi.fn(async () => 1),
  addInventoryItem: vi.fn(async () => 7),
  getUserInventory: vi.fn(async () => []),
  updateInventoryItem: vi.fn(async () => 1),
  deleteInventoryItem: vi.fn(async () => 1),
  listProduceInventory: vi.fn(async () => []),
  addProduceInventoryItem: vi.fn(async () => 11),
  deleteProduceInventoryItem: vi.fn(async () => false),
  listProduceScans: vi.fn(async () => []),
  addProduceScan: vi.fn(async () => 21),
  clearProduceScans: vi.fn(),
}));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./storage", () => ({ storagePut: vi.fn(async (k: string) => ({ key: k, url: "/uploads/x" })) }));

import { appRouter } from "./routers";
import * as db from "./db";
import { invokeLLM } from "./_core/llm";
import { storagePut } from "./storage";

const caller = appRouter.createCaller({
  user: { id: 5, openId: "o", role: "user" },
  req: {} as any,
  res: {} as any,
} as any);

beforeEach(() => vi.clearAllMocks());

describe("authorization on scan-scoped procedures", () => {
  beforeEach(() => (db.getFoodScan as any).mockResolvedValue(undefined)); // scan belongs to someone else

  it("chat.sendMessage rejects foreign scans and does not persist or leak", async () => {
    await expect(caller.chat.sendMessage({ message: "hi", scanId: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.addChatMessage).not.toHaveBeenCalled();
    expect(db.getScanIngredients).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
  });
  it("analysis.analyzeIngredients rejects foreign scans", async () => {
    await expect(caller.analysis.analyzeIngredients({ scanId: 99, ingredients: "sugar" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.addScanIngredient).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
  });
  it("scanner.processOCR rejects foreign scans", async () => {
    await expect(caller.scanner.processOCR({ scanId: 99, imageUrl: "https://x/y.png" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(invokeLLM).not.toHaveBeenCalled();
  });
});

describe("analysis.analyzeIngredients", () => {
  beforeEach(() => (db.getFoodScan as any).mockResolvedValue({ id: 1, userId: 5 }));

  it("tolerates fenced JSON, bad entries and out-of-range score", async () => {
    (invokeLLM as any).mockResolvedValue({
      choices: [{ message: { content: '```json\n{"ingredients":[{"name":"Sugar","riskLevel":"high"},{"riskLevel":"low"}],"overallRiskScore":250,"summary":"s"}\n```' } }],
    });
    await caller.analysis.analyzeIngredients({ scanId: 1, ingredients: "sugar" });
    expect(db.deleteScanIngredients).toHaveBeenCalledWith(1);
    expect(db.addScanIngredient).toHaveBeenCalledTimes(1);
    expect(db.updateFoodScan).toHaveBeenCalledWith(1, 5, { riskScore: 100, analysisComplete: true });
  });
  it("fails cleanly (and keeps old data) on garbage LLM output", async () => {
    (invokeLLM as any).mockResolvedValue({ choices: [{ message: { content: "sorry" } }] });
    await expect(caller.analysis.analyzeIngredients({ scanId: 1, ingredients: "sugar" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(db.deleteScanIngredients).not.toHaveBeenCalled();
  });
  it("rejects empty ingredients", async () => {
    await expect(caller.analysis.analyzeIngredients({ scanId: 1, ingredients: "  " })).rejects.toThrow();
  });
});

describe("input validation", () => {
  it("medication partial update does not inject isCurrent default", async () => {
    await caller.profile.updateMedication({ id: 1, updates: { dosage: "5mg" } });
    expect(db.updateMedication).toHaveBeenCalledWith(1, 5, { dosage: "5mg" });
  });
  it("inventory.add rejects invalid and out-of-range dates, accepts valid", async () => {
    await expect(caller.inventory.add({ title: "Milk", expiryDate: "not-a-date" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.inventory.add({ title: "Milk", expiryDate: "2099-01-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.inventory.add({ title: "Milk", expiryDate: "2026-12-01" })).resolves.toMatchObject({ id: 7 });
  });
  it("uploadImage sanitises file name and rejects non-images", async () => {
    await caller.scanner.uploadImage({ fileName: "../../evil.png", fileData: Buffer.from("abc").toString("base64"), mimeType: "image/png" });
    expect((storagePut as any).mock.calls[0][0]).toMatch(/^scans\/5\/\d+-[0-9a-f]{16}-evil\.png$/);
    await expect(caller.scanner.uploadImage({ fileName: "a.exe", fileData: "AAAA", mimeType: "application/x-msdownload" })).rejects.toThrow();
  });
});

describe("openFoodFacts error handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null for an unknown barcode (404) without calling out for invalid input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(caller.openFoodFacts.getByBarcode({ barcode: "12" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(caller.openFoodFacts.getByBarcode({ barcode: "4006381333931" })).resolves.toBeNull();
  });

  it("surfaces an outage as SERVICE_UNAVAILABLE instead of 'not found'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(caller.openFoodFacts.getByBarcode({ barcode: "4006381333931" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 503 })));
    await expect(caller.openFoodFacts.search({ query: "biscuits" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe("produce (FreshGuard) per-user storage", () => {
  const item = {
    name: "Apple", fruit: "apple", freshness: "fresh" as const, pFresh: 91.2, confidence: 99.1,
    imageUrl: "/static/samples/apple.jpg", expiryDate: "2099-01-10", storageTip: "Refrigerate.",
  };

  it("scopes every read and write to the signed-in user", async () => {
    await caller.produce.addInventory(item);
    expect(db.addProduceInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, fruitType: "apple", expiryDate: "2099-01-10" }));
    await caller.produce.listInventory();
    expect(db.listProduceInventory).toHaveBeenCalledWith(5);
    await caller.produce.listHistory();
    expect(db.listProduceScans).toHaveBeenCalledWith(5, 50);
    await caller.produce.clearHistory();
    expect(db.clearProduceScans).toHaveBeenCalledWith(5);
    await caller.produce.recordScan({ fruit: "apple", fruitName: "Apple", freshness: "fresh", freshnessLabel: "Fresh", pFresh: 90, confidence: 99, imageUrl: "/static/uploads/abc.jpg" });
    expect(db.addProduceScan).toHaveBeenCalledWith(expect.objectContaining({ userId: 5 }));
  });

  it("returns NOT_FOUND when deleting an item the user does not own", async () => {
    (db.deleteProduceInventoryItem as any).mockResolvedValueOnce(false);
    await expect(caller.produce.deleteInventory({ id: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.deleteProduceInventoryItem).toHaveBeenCalledWith(99, 5);
    (db.deleteProduceInventoryItem as any).mockResolvedValueOnce(true);
    await expect(caller.produce.deleteInventory({ id: 1 })).resolves.toEqual({ success: true });
  });

  it("rejects external image URLs, bad dates and out-of-range scores", async () => {
    await expect(caller.produce.addInventory({ ...item, imageUrl: "https://evil.example/x.png" })).rejects.toThrow();
    await expect(caller.produce.addInventory({ ...item, imageUrl: "/static/uploads/../../etc/passwd" })).rejects.toThrow();
    await expect(caller.produce.addInventory({ ...item, expiryDate: "10/01/2099" })).rejects.toThrow();
    await expect(caller.produce.addInventory({ ...item, expiryDate: "2099-13-45" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.produce.addInventory({ ...item, pFresh: 120 })).rejects.toThrow();
    expect(db.addProduceInventoryItem).not.toHaveBeenCalled();
  });

  it("maps rows to the shape the Produce page renders and computes days left", async () => {
    const day = 86_400_000;
    const ymd = (offset: number) => new Date(Date.now() + offset * day).toISOString().slice(0, 10);
    (db.listProduceInventory as any).mockResolvedValueOnce([
      { id: 1, userId: 5, name: "Apple", fruitType: "apple", freshness: "fresh", pFresh: 90, confidence: 99, imageUrl: null, expiryDate: ymd(3), storageTip: null, createdAt: new Date("2026-01-01T10:00:00Z") },
      { id: 2, userId: 5, name: "Banana", fruitType: "banana", freshness: "rotten", pFresh: 5, confidence: 80, imageUrl: "/static/samples/banana.jpg", expiryDate: ymd(-4), storageTip: "x", createdAt: new Date("2026-01-01T10:00:00Z") },
    ]);
    const rows = await caller.produce.listInventory();
    expect(rows[0]).toMatchObject({ fruit_type: "apple", days_left: 3, image_url: "", storage_tip: "" });
    expect(rows[1]).toMatchObject({ days_left: -4, image_url: "/static/samples/banana.jpg" });
    expect(rows[0].created_at).toBe("2026-01-01T10:00:00.000Z");
  });
});
