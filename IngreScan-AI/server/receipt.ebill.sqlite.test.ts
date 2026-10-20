// Real appRouter on a real temporary SQLite DB: receipt.parse with an uploaded e-bill, then receipt.importItems.
// The bill below is a SYNTHETIC fixture (hand-written, not a real merchant bill).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-ebill-"));
const saved = { url: process.env.DATABASE_URL, sqlite: process.env.SQLITE_PATH };
let appRouter: typeof import("./routers").appRouter;
let db: typeof import("./db");
let database: typeof import("./_core/database");

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.SQLITE_PATH = path.join(tmpDir, "t.db");
  database = await import("./_core/database");
  db = await import("./db");
  ({ appRouter } = await import("./routers"));
});

afterAll(async () => {
  await database.closeDatabase();
  for (const [k, v] of [["DATABASE_URL", saved.url], ["SQLITE_PATH", saved.sqlite]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore EPERM / EBUSY lock errors on Windows
  }
});

async function user(openId: string) {
  await db.upsertUser({ openId, name: openId, loginMethod: "local" });
  const u = (await db.getUserByOpenId(openId))!;
  return appRouter.createCaller({ user: u as any, req: { headers: {} } as any, res: {} as any });
}

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const html = (when: string) => `<html><head><title>Your Zepto order</title></head><body><table>
<tr><td>Zepto</td></tr><tr><td>Ordered on ${when}</td></tr>
<tr><td>Banana Robusta (6 pcs)</td><td>x 1</td><td>Rs 49</td></tr>
<tr><td>Amul Butter (100 g)</td><td>2 x Rs 58</td><td>Rs 116</td></tr>
<tr><td>Dettol Handwash Refill 175 ml</td><td>Rs 99</td></tr>
<tr><td>Handling Fee</td><td>Rs 4</td></tr><tr><td>To Pay</td><td>Rs 169</td></tr></table></body></html>`;

describe("receipt.parse with an uploaded e-bill", () => {
  it("returns merchant, order date and doubtful-line confidence, and the import keeps the chosen dates", async () => {
    const caller = await user("ebill-a");
    const when = daysAgo(2);
    const res = await caller.receipt.parse({ ebill: { content: html(when), filename: "order.html" } });
    expect(res.source).toBe("parser");
    expect(res.merchant).toBe("Zepto");
    expect(res.ebillFormat).toBe("html");
    expect(res.orderDate).toBe(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10));
    expect(res.orderDateSource).toBe("bill");
    expect(res.items.map((i) => i.name)).toEqual(["Banana Robusta", "Amul Butter"]);
    expect(res.skipped.some((s) => s.reason === "non_food")).toBe(true);
    const butter = res.items[1];
    expect(butter.lineConfidence).toBe("high");

    const out = await caller.receipt.importItems({
      items: res.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        category: i.category,
        storageLocation: i.suggestedLocation,
        expiryDate: i.suggestedExpiryDate!,
      })),
    });
    expect(out.imported).toBe(2);
  });

  it("rejects an upload with no readable text (PDF) with a clear message", async () => {
    const caller = await user("ebill-b");
    await expect(caller.receipt.parse({ ebill: { content: "%PDF-1.7 binary", filename: "bill.pdf" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/PDF files are not supported/),
    });
  });

  it("keeps plain pasted receipts on the old path (no merchant, no order date)", async () => {
    const caller = await user("ebill-c");
    const res = await caller.receipt.parse({ text: "Milk 1 L  Rs 60\nBread  Rs 40\nTotal Rs 100" });
    expect(res.merchant).toBeNull();
    expect(res.orderDate).toBeNull();
    expect(res.items.length).toBeGreaterThanOrEqual(2);
  });

  it("treats pasted e-bill HTML as an e-bill", async () => {
    const caller = await user("ebill-d");
    const res = await caller.receipt.parse({ text: html(daysAgo(1)) });
    expect(res.ebillFormat).toBe("html");
    expect(res.merchant).toBe("Zepto");
  });

  it("rejects an empty request", async () => {
    const caller = await user("ebill-e");
    await expect(caller.receipt.parse({} as any)).rejects.toBeTruthy();
    await expect(caller.receipt.parse({ ebill: { content: "   " } })).rejects.toBeTruthy();
  });
});
