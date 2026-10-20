import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingrescan-household-test-"));
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
}, 30000);

afterAll(async () => {
  await database.closeDatabase();
  for (const [k, v] of [["DATABASE_URL", saved.url], ["SQLITE_PATH", saved.sqlite]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows file lock ignore
  }
}, 30000);

async function createUser(openId: string, name: string) {
  await db.upsertUser({ openId, name, loginMethod: "local" });
  const u = (await db.getUserByOpenId(openId))!;
  const caller = appRouter.createCaller({ user: u as any, req: { headers: {} } as any, res: {} as any });
  return { u, caller };
}

describe("Multi-Member Household Fridge (in-app pantry sharing)", () => {
  it("allows creating a household and generates a 6-character uppercase invite code", async () => {
    const alice = await createUser("alice_101", "Alice");
    const created = await alice.caller.household.create({ name: "Alice & Bob Flat" });

    expect(created.success).toBe(true);
    expect(created.household.name).toBe("Alice & Bob Flat");
    expect(created.household.inviteCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);

    const current = await alice.caller.household.get();
    expect(current).not.toBeNull();
    expect(current?.household.name).toBe("Alice & Bob Flat");
    expect(current?.isOwner).toBe(true);
    expect(current?.myRole).toBe("owner");
    expect(current?.members.length).toBe(1);
    expect(current?.members[0].userId).toBe(alice.u.id);
  });

  it("allows another user to join the household using the invite code", async () => {
    const alice = await createUser("alice_101", "Alice");
    const bob = await createUser("bob_102", "Bob");

    const currentAlice = await alice.caller.household.get();
    const code = currentAlice!.household.inviteCode;

    // Bob joins with code
    const joinResult = await bob.caller.household.join({ inviteCode: code.toLowerCase() }); // test case insensitivity
    expect(joinResult.success).toBe(true);
    expect(joinResult.household.id).toBe(currentAlice!.household.id);

    // Verify Bob's view
    const currentBob = await bob.caller.household.get();
    expect(currentBob).not.toBeNull();
    expect(currentBob?.isOwner).toBe(false);
    expect(currentBob?.myRole).toBe("member");
    expect(currentBob?.members.length).toBe(2);

    // Verify Alice's view now has 2 members
    const updatedAlice = await alice.caller.household.get();
    expect(updatedAlice?.members.length).toBe(2);
  });

  it("shares food items across all household members", async () => {
    const alice = await createUser("alice_101", "Alice");
    const bob = await createUser("bob_102", "Bob");

    // Alice adds an item to the fridge
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + 5);

    const addRes = await alice.caller.inventory.add({
      title: "Shared Organic Oat Milk",
      category: "Dairy",
      quantity: "2 cartons",
      storageLocation: "fridge",
      expiryDate: expDate.toISOString(),
      notes: "For everyone in the flat",
    });

    expect(addRes.success).toBe(true);

    // Bob lists inventory: Bob must see Alice's oat milk!
    const bobItems = await bob.caller.inventory.list();
    const foundOatMilk = bobItems.find((i) => i.title === "Shared Organic Oat Milk");
    expect(foundOatMilk).toBeDefined();
    expect(foundOatMilk?.quantity).toBe("2 cartons");

    // Bob can mark it consumed
    const consumeRes = await bob.caller.inventory.consume({ id: foundOatMilk!.id });
    expect(consumeRes.success).toBe(true);

    // Alice now sees the item as consumed
    const aliceItems = await alice.caller.inventory.list();
    const aliceItem = aliceItems.find((i) => i.id === foundOatMilk!.id);
    expect(aliceItem?.status).toBe("consumed");
  });

  it("rejects joining with an invalid invite code", async () => {
    const charlie = await createUser("charlie_103", "Charlie");
    await expect(charlie.caller.household.join({ inviteCode: "INVALID" })).rejects.toThrow(/Invalid invite code/i);
  });

  it("handles member leaving and transfers ownership cleanly", async () => {
    const alice = await createUser("alice_101", "Alice");
    const bob = await createUser("bob_102", "Bob");

    // Alice (owner) leaves the household
    const leaveRes = await alice.caller.household.leave();
    expect(leaveRes.success).toBe(true);

    // Bob is now the owner
    const bobView = await bob.caller.household.get();
    expect(bobView).not.toBeNull();
    expect(bobView?.isOwner).toBe(true);
    expect(bobView?.myRole).toBe("owner");
    expect(bobView?.members.length).toBe(1);

    // Bob leaves too -> household is deleted
    await bob.caller.household.leave();
    const finalBobView = await bob.caller.household.get();
    expect(finalBobView).toBeNull();
  });
});
