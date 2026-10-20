import { describe, expect, it } from "vitest";
import { computeDueReminders, inQuietHours, runReminders } from "./reminders";
import { FakeSender, MemoryStore, makeLink } from "./testkit";
import { localDate, localParts } from "./time";
import type { PantryItem, ReminderLink } from "./types";

const item = (name: string, expiryDate: string | null): PantryItem => ({ id: name, name, kind: "produce", expiryDate });
const rl = (over: Partial<ReminderLink> = {}): ReminderLink => ({
  ...makeLink({ timezone: "Asia/Kolkata", lastInboundAt: null }),
  items: [item("Milk", "2026-10-15")],
  ...over,
});
const config = { reminderTemplate: { name: "pantry_expiry_reminder", language: "en" } };
const due = (links: ReminderLink[], now: number, cfg = config) => computeDueReminders({ links, now, config: cfg });
const T = (iso: string) => Date.parse(iso);

describe("local time math", () => {
  it("Asia/Kolkata half-hour offset", () => {
    expect(localParts(T("2026-10-14T03:30:00Z"), "Asia/Kolkata")).toMatchObject({ year: 2026, month: 10, day: 14, hour: 9, minute: 0 });
    expect(localParts(T("2026-10-14T03:29:00Z"), "Asia/Kolkata")).toMatchObject({ hour: 8, minute: 59 });
    expect(localDate(T("2026-10-14T18:30:00Z"), "Asia/Kolkata")).toBe("2026-10-15");
    expect(localDate(T("2026-10-14T18:29:00Z"), "Asia/Kolkata")).toBe("2026-10-14");
  });
  it("midnight renders as hour 0, not 24", () => {
    expect(localParts(T("2026-10-14T18:30:00Z"), "Asia/Kolkata").hour).toBe(0);
    expect(localParts(T("2026-10-14T00:00:00Z"), "UTC").hour).toBe(0);
  });
  it("America/New_York fall-back (2026-11-01) and spring-forward (2026-03-08)", () => {
    expect(localParts(T("2026-11-01T05:30:00Z"), "America/New_York")).toMatchObject({ day: 1, hour: 1, minute: 30 }); // EDT
    expect(localParts(T("2026-11-01T06:30:00Z"), "America/New_York")).toMatchObject({ day: 1, hour: 1, minute: 30 }); // EST (repeated hour)
    expect(localParts(T("2026-11-01T14:00:00Z"), "America/New_York").hour).toBe(9);
    expect(localParts(T("2026-03-08T06:59:00Z"), "America/New_York")).toMatchObject({ hour: 1, minute: 59 });
    expect(localParts(T("2026-03-08T07:00:00Z"), "America/New_York")).toMatchObject({ hour: 3, minute: 0 });
  });
});

describe("computeDueReminders timing", () => {
  it("fires at the preferred local hour in Kolkata (09:00 IST = 03:30Z)", () => {
    expect(due([rl()], T("2026-10-14T03:29:00Z"))).toHaveLength(0);
    const r = due([rl()], T("2026-10-14T03:30:00Z"));
    expect(r).toHaveLength(1);
    expect(r[0].localDate).toBe("2026-10-14");
    expect(r[0].items).toEqual([{ name: "Milk", daysLeft: 1 }]);
  });

  it("is due later in the day too (catch-up) but not in quiet hours", () => {
    expect(due([rl()], T("2026-10-14T10:00:00Z"))).toHaveLength(1); // 15:30 IST
    expect(due([rl()], T("2026-10-14T16:00:00Z"))).toHaveLength(0); // 21:30 IST, quiet
  });

  it("notifies at most once per local calendar day", () => {
    const now = T("2026-10-14T05:00:00Z");
    expect(due([rl({ lastReminderLocalDate: "2026-10-14" })], now)).toHaveLength(0);
    expect(due([rl({ lastReminderLocalDate: "2026-10-13" })], now)).toHaveLength(1);
    // Next local day, 24h later, due again.
    expect(due([rl({ lastReminderLocalDate: "2026-10-14" })], now + 24 * 3600_000)).toHaveLength(1);
  });

  it("uses the user's local date, not UTC", () => {
    // 2026-10-14T20:00Z is 2026-10-15 01:30 IST (before 09:00) -> not due yet, even though UTC date is the 14th.
    expect(due([rl({ lastReminderLocalDate: "2026-10-14" })], T("2026-10-14T20:00:00Z"))).toHaveLength(0);
    // 2026-10-15T04:00Z is 09:30 IST on the 15th -> due.
    const r = due([rl({ lastReminderLocalDate: "2026-10-14" })], T("2026-10-15T04:00:00Z"));
    expect(r[0].localDate).toBe("2026-10-15");
  });

  it("respects opt-out and per-user hour", () => {
    expect(due([rl({ remindersEnabled: false })], T("2026-10-14T05:00:00Z"))).toHaveLength(0);
    const now = T("2026-10-14T07:00:00Z"); // 12:30 IST
    expect(due([rl({ reminderHour: 13 })], now)).toHaveLength(0);
    expect(due([rl({ reminderHour: 12 })], now)).toHaveLength(1);
    expect(due([rl({ reminderHour: 99 })], T("2026-10-14T03:30:00Z"))).toHaveLength(1); // falls back to 9
  });

  it("quiet-hours guard delays an early preferred hour until it ends", () => {
    const l = rl({ reminderHour: 6 });
    expect(due([l], T("2026-10-14T01:00:00Z"))).toHaveLength(0); // 06:30 IST, quiet
    expect(due([l], T("2026-10-14T02:30:00Z"))).toHaveLength(1); // 08:00 IST
    expect(inQuietHours(21)).toBe(true);
    expect(inQuietHours(7)).toBe(true);
    expect(inQuietHours(8)).toBe(false);
    expect(inQuietHours(20)).toBe(false);
    expect(inQuietHours(23, { startHour: 22, endHour: 23 })).toBe(false);
  });

  it("handles DST in America/New_York", () => {
    const ny = (over: Partial<ReminderLink> = {}) => rl({ timezone: "America/New_York", reminderHour: 9, items: [item("Milk", "2026-11-02")], ...over });
    // Before fall-back: 09:00 EDT = 13:00Z on Oct 31
    expect(due([ny()], T("2026-10-31T12:59:00Z"))).toHaveLength(0);
    expect(due([ny()], T("2026-10-31T13:00:00Z"))[0].items[0].daysLeft).toBe(2);
    // After fall-back: 09:00 EST = 14:00Z on Nov 1; 13:00Z is only 08:00 EST
    expect(due([ny()], T("2026-11-01T13:00:00Z"))).toHaveLength(0);
    const r = due([ny()], T("2026-11-01T14:00:00Z"));
    expect(r[0].localDate).toBe("2026-11-01");
    expect(r[0].items[0].daysLeft).toBe(1);
    // Spring forward: 02:00 does not exist on 2026-03-08; hour 3 is the first local hour >= 2.
    const spring = ny({ reminderHour: 2, items: [item("Milk", "2026-03-09")] });
    const q = { ...config, quietHours: { startHour: 23, endHour: 1 } };
    expect(due([spring], T("2026-03-08T06:59:00Z"), q)).toHaveLength(0); // 01:59 EST
    expect(due([spring], T("2026-03-08T07:00:00Z"), q)).toHaveLength(1); // 03:00 EDT
  });

  it("falls back to the default timezone for an invalid zone", () => {
    expect(due([rl({ timezone: "Nope/Zone", items: [item("Milk", "2026-10-14")] })], T("2026-10-14T10:00:00Z"))).toHaveLength(1);
  });
});

describe("computeDueReminders content", () => {
  const now = T("2026-10-14T05:00:00Z"); // IST date 2026-10-14
  it("includes only items due within 48 hours, sorted by urgency", () => {
    const l = rl({
      lastInboundAt: now - 1000,
      items: [
        item("Eggs", "2026-10-16"),
        item("Rice", "2026-10-17"),
        item("Old", "2026-10-13"),
        item("Salt", null),
        item("Spinach", "2026-10-14"),
        item("Milk", "2026-10-15"),
        item("Bad", "not-a-date"),
      ],
    });
    const [r] = due([l], now);
    expect(r.items).toEqual([
      { name: "Spinach", daysLeft: 0 },
      { name: "Milk", daysLeft: 1 },
      { name: "Eggs", daysLeft: 2 },
    ]);
    expect(r.text).toContain("- Spinach: today");
    expect(r.text).toContain("- Milk: tomorrow");
    expect(r.text).toContain("- Eggs: in 2 days");
    expect(r.text).toContain("Reply COOK for a recipe");
  });
  it("sends nothing when no item is close to expiry", () => {
    expect(due([rl({ items: [item("Rice", "2026-12-01")] })], now)).toHaveLength(0);
    expect(due([rl({ items: [] })], now)).toHaveLength(0);
  });
});

describe("24-hour customer-service window", () => {
  const now = T("2026-10-14T05:00:00Z");
  const H = 3600_000;
  it("uses a session text when the last inbound message is under 24h old", () => {
    const [r] = due([rl({ lastInboundAt: now - 24 * H + 1 })], now);
    expect(r.mode).toBe("session");
    expect(r.text).toBeTruthy();
    expect(r.template).toBeUndefined();
  });
  it("uses the approved template at exactly 24h, beyond it, or with no inbound history", () => {
    for (const last of [now - 24 * H, now - 48 * H, null]) {
      const [r] = due([rl({ lastInboundAt: last })], now);
      expect(r.mode).toBe("template");
      expect(r.text).toBeUndefined();
      expect(r.template).toEqual({ name: "pantry_expiry_reminder", language: "en", variables: ["Milk (tomorrow)"] });
    }
  });
  it("ignores an inbound timestamp from the future", () => {
    expect(due([rl({ lastInboundAt: now + H })], now)[0].mode).toBe("template");
  });
  it("takes the template name from config", () => {
    const [r] = due([rl()], now, { reminderTemplate: { name: "custom_name", language: "en_GB" } });
    expect(r.template).toMatchObject({ name: "custom_name", language: "en_GB" });
  });
});

describe("runReminders", () => {
  const setup = () => {
    const store = new MemoryStore();
    store.links.set("+919876543210", makeLink({ lastInboundAt: null }));
    store.items = [item("Milk", "2026-10-15")];
    return { store, sender: new FakeSender() };
  };
  const now = T("2026-10-14T05:00:00Z");

  it("sends a template outside the window, then never again that local day", async () => {
    const { store, sender } = setup();
    expect(await runReminders({ store, sender, config, now })).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(sender.templates).toHaveLength(1);
    expect(sender.texts).toHaveLength(0);
    expect(store.links.get("+919876543210")!.lastReminderLocalDate).toBe("2026-10-14");
    expect(await runReminders({ store, sender, config, now: now + 3600_000 })).toEqual({ due: 0, sent: 0, failed: 0 });
    expect(sender.templates).toHaveLength(1);
  });

  it("sends a session text inside the window", async () => {
    const { store, sender } = setup();
    store.links.get("+919876543210")!.lastInboundAt = now - 3600_000;
    await runReminders({ store, sender, config, now });
    expect(sender.texts[0].text).toContain("Reply COOK for a recipe");
    expect(sender.templates).toHaveLength(0);
  });

  it("counts failures without throwing and without double-sending (marked first)", async () => {
    const { store, sender } = setup();
    sender.sendTemplate = async () => {
      throw new Error("boom");
    };
    const logs: string[] = [];
    const res = await runReminders({ store, sender, config, now, log: (_l, m, meta) => logs.push(m + JSON.stringify(meta)) });
    expect(res).toEqual({ due: 1, sent: 0, failed: 1 });
    expect(logs[0]).toContain("reminder_send_failed");
    expect((await runReminders({ store, sender, config, now })).due).toBe(1);
  });
});
