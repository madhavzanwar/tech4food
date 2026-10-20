import { reminderTemplateVariable, reminderText, type ReminderItem } from "./format";
import { daysBetween, isValidTimeZone, localDate, localParts } from "./time";
import type { BotConfig, ReminderLink, Sender, Store, TemplateSend } from "./types";

export interface DueReminder {
  phone: string;
  userId: string;
  /** Local date to record via Store.markReminded. */
  localDate: string;
  mode: "session" | "template";
  items: ReminderItem[];
  /** Present when mode === "session". */
  text?: string;
  /** Present when mode === "template". */
  template?: TemplateSend;
}

export type ReminderConfig = Partial<
  Pick<BotConfig, "reminderTemplate" | "quietHours" | "reminderDays" | "sessionWindowMs" | "defaultTimezone" | "useEmoji">
>;

export const DEFAULT_QUIET_HOURS = { startHour: 21, endHour: 8 };
export const DEFAULT_REMINDER_TEMPLATE = { name: "pantry_expiry_reminder", language: "en" };

/** Template body to submit for approval (category UTILITY). {{1}} is a single-line item list. */
export const REMINDER_TEMPLATE_BODY =
  "Pantry reminder: these items are expiring soon: {{1}}. Reply COOK for a recipe, or STOP to turn off reminders.";

export function inQuietHours(hour: number, q = DEFAULT_QUIET_HOURS): boolean {
  return q.startHour > q.endHour ? hour >= q.startHour || hour < q.endHour : hour >= q.startHour && hour < q.endHour;
}

export function computeDueReminders(args: {
  links: ReminderLink[];
  now: number;
  config?: ReminderConfig;
}): DueReminder[] {
  const cfg = args.config ?? {};
  const quiet = cfg.quietHours ?? DEFAULT_QUIET_HOURS;
  const maxDays = cfg.reminderDays ?? 2;
  const windowMs = cfg.sessionWindowMs ?? 24 * 60 * 60 * 1000;
  const tpl = cfg.reminderTemplate ?? DEFAULT_REMINDER_TEMPLATE;
  const out: DueReminder[] = [];

  for (const link of args.links) {
    if (!link.remindersEnabled) continue;
    const tz = isValidTimeZone(link.timezone) ? link.timezone : cfg.defaultTimezone ?? "UTC";
    const hourPref = Number.isInteger(link.reminderHour) && link.reminderHour >= 0 && link.reminderHour <= 23 ? link.reminderHour : 9;
    const parts = localParts(args.now, tz);
    const today = localDate(args.now, tz);
    if (link.lastReminderLocalDate === today) continue;
    if (parts.hour < hourPref) continue;
    if (inQuietHours(parts.hour, quiet)) continue;

    const items: ReminderItem[] = [];
    for (const it of link.items) {
      if (!it.expiryDate) continue;
      const d = daysBetween(today, it.expiryDate);
      if (Number.isFinite(d) && d >= 0 && d <= maxDays) items.push({ name: it.name, daysLeft: d });
    }
    if (items.length === 0) continue;
    items.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));

    const inWindow = link.lastInboundAt !== null && args.now - link.lastInboundAt >= 0 && args.now - link.lastInboundAt < windowMs;
    if (inWindow) {
      out.push({
        phone: link.phone,
        userId: link.userId,
        localDate: today,
        mode: "session",
        items,
        text: reminderText(items, { useEmoji: cfg.useEmoji }),
      });
    } else {
      out.push({
        phone: link.phone,
        userId: link.userId,
        localDate: today,
        mode: "template",
        items,
        template: { name: tpl.name, language: tpl.language, variables: [reminderTemplateVariable(items)] },
      });
    }
  }
  return out;
}

/**
 * Job body for a scheduler (e.g. every 15 minutes). Marks the local date BEFORE sending
 * so a user is notified at most once per local day, even if the job overlaps or retries.
 */
export async function runReminders(args: {
  store: Store;
  sender: Sender;
  config?: ReminderConfig;
  now?: number;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}): Promise<{ due: number; sent: number; failed: number }> {
  const now = args.now ?? Date.now();
  const links = await args.store.listReminderCandidates();
  const due = computeDueReminders({ links, now, config: args.config });
  let sent = 0;
  let failed = 0;
  for (const d of due) {
    try {
      if (d.mode === "session") await args.sender.sendText(d.phone, d.text!);
      else await args.sender.sendTemplate(d.phone, d.template!);
      await args.store.markReminded(d.phone, d.localDate);
      sent++;
    } catch (err) {
      failed++;
      args.log?.("error", "reminder_send_failed", { mode: d.mode, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { due: due.length, sent, failed };
}
