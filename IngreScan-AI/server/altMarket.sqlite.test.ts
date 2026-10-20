// Real appRouter on a real temporary SQLite DB: ownership scoping + region handling of analysis.alternativeMarket.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-altmkt-"));
const saved = { url: process.env.DATABASE_URL, sqlite: process.env.SQLITE_PATH, off: process.env.OPENFOODFACTS_BASE_URL, op: process.env.OPEN_PRICES_BASE_URL };
let appRouter: typeof import("./routers").appRouter;
let db: typeof import("./db");
let database: typeof import("./_core/database");
let altMarket: typeof import("./lib/altMarket");
let stub: http.Server;
const hits: string[] = [];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.SQLITE_PATH = path.join(tmpDir, "t.db");
  stub = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url!.startsWith("/cgi/search.pl")) {
      res.end(JSON.stringify({ products: [{ code: "8901234567890", product_name: "Rolled Oats", brands: "Quaker", stores: "DMart" }] }));
    } else {
      res.end(JSON.stringify({ items: [{ price: 99, currency: "INR", date: new Date().toISOString().slice(0, 10), location: { osm_name: "DMart", osm_address_country_code: "IN" } }] }));
    }
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  process.env.OPENFOODFACTS_BASE_URL = base;
  process.env.OPEN_PRICES_BASE_URL = base;
  database = await import("./_core/database");
  db = await import("./db");
  altMarket = await import("./lib/altMarket");
  ({ appRouter } = await import("./routers"));
});

afterAll(async () => {
  stub.close();
  await database.closeDatabase();
  for (const [k, v] of [["DATABASE_URL", saved.url], ["SQLITE_PATH", saved.sqlite], ["OPENFOODFACTS_BASE_URL", saved.off], ["OPEN_PRICES_BASE_URL", saved.op]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
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
  return { u, caller: appRouter.createCaller({ user: u as any, req: { headers: {} } as any, res: {} as any }) };
}

describe("analysis.alternativeMarket", () => {
  it("is scoped to the scan owner, uses the profile region, and never errors on upstream data", async () => {
    altMarket.resetAltMarketRate();
    const a = await user("alt-a");
    const b = await user("alt-b");
    const scanId = (await a.caller.scanner.createScan({ productName: "Choco Cereal", inputType: "text", rawIngredients: "Sugar, Salt" })).scanId;
    await db.addAlternative({ scanId, productName: "Rolled Oats", brand: "Quaker", reason: "Less sugar" });
    await db.addAlternative({ scanId, productName: "Totally Unknown Thing", brand: "", reason: "r" });
    await db.upsertUserProfile({ userId: a.u.id, region: "Pune, India" } as any);

    await expect(b.caller.analysis.alternativeMarket({ scanId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(hits).toHaveLength(0); // no outbound call for a stranger

    const res = await a.caller.analysis.alternativeMarket({ scanId });
    expect(res.country).toEqual({ code: "IN", name: "India" });
    expect(hits.some((h) => h.includes("tag_0=india"))).toBe(true);
    expect(res.items).toHaveLength(2);
    expect(res.attribution).toContain("Open Food Facts");
    const ok = res.items.find((i) => i.status === "ok")!;
    expect(ok.match?.code).toBe("8901234567890");
    expect(ok.price).toMatchObject({ amount: 99, currency: "INR" });
    expect(res.items.find((i) => i.status === "no_match")).toBeTruthy();
  });

  it("rate limits per user", async () => {
    altMarket.resetAltMarketRate();
    const c = await user("alt-c");
    const scanId = (await c.caller.scanner.createScan({ productName: "X", inputType: "text", rawIngredients: "Salt" })).scanId;
    for (let i = 0; i < 20; i++) await c.caller.analysis.alternativeMarket({ scanId });
    await expect(c.caller.analysis.alternativeMarket({ scanId })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
