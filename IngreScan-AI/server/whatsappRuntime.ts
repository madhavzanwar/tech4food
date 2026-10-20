/**
 * WhatsApp bot runtime: connects the framework-free core in ./whatsapp to the real database, the real tRPC
 * logic (same code paths and ownership checks as the website), the FreshGuard service, Twilio / Meta Cloud API
 * and the reminder scheduler. See docs/whatsapp-bot.md.
 */
import express, { type Express, type Request, type Response } from "express";
import { evaluateHealthAlerts } from "@shared/engines";
import type { User } from "../drizzle/schema";
import { invokeLLM, isRealLLMConfigured } from "./_core/llm";
import * as dbf from "./dbFeatures";
import { getLLMText } from "./logic";
import { decodeBarcodeFromImage } from "./lib/serverBarcode";
import { appRouter } from "./routers";
import {
  AttemptLimiter,
  checkLinkCode,
  createDefaultRateLimiter,
  TokenBucketLimiter,
  createMetaSender,
  createTwilioSender,
  deliver,
  downloadMetaMedia,
  downloadTwilioMedia,
  findMatchingLinkRecord,
  processMetaWebhook,
  processTwilioWebhook,
  runReminders,
  type BotConfig,
  type ConversationState,
  type DownloadedMedia,
  type HandlerDeps,
  type ImageInterpretation,
  type LinkRecord,
  type LinkResult,
  type MediaRef,
  type NewPantryItem,
  type PackagedReport,
  type PantryItem,
  type ProduceClassification,
  type Provider,
  type Recipe,
  type ReminderLink,
  type ReminderPrefs,
  type Sender,
  type Services,
  type Store,
} from "./whatsapp";
import { getWhatsappEnv, isWhatsappConfigured, type WhatsappEnv } from "./whatsappConfig";

type LogLevel = "info" | "warn" | "error";
const log = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
  const line = `[WhatsApp] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const FRESHGUARD_URL = () => process.env.FRESHGUARD_URL ?? "http://127.0.0.1:5000";

// ------------------------------------------------------------------------- Store

function toLinkRecord(row: NonNullable<Awaited<ReturnType<typeof dbf.getWhatsappLinkByPhone>>>): LinkRecord {
  return {
    phone: row.phone,
    userId: String(row.userId),
    timezone: row.timezone,
    reminderHour: row.reminderHour,
    remindersEnabled: row.remindersEnabled,
    lastInboundAt: row.lastInboundAt ? row.lastInboundAt.getTime() : null,
    lastReminderLocalDate: row.lastReminderLocalDate ?? null,
  };
}

export function createWhatsappStore(): Store {
  return {
    seenMessage: (provider, id) => dbf.seenWhatsappMessage(provider, id),
    async getLink(phone) {
      const row = await dbf.getWhatsappLinkByPhone(phone);
      return row ? toLinkRecord(row) : null;
    },
    touchInbound: (phone, at) => dbf.touchWhatsappInbound(phone, new Date(at)),
    async getConversation(phone) {
      const json = await dbf.getWhatsappConversationJson(phone);
      if (!json) return null;
      try {
        return JSON.parse(json) as ConversationState;
      } catch {
        return null;
      }
    },
    setConversation: (phone, state) => dbf.setWhatsappConversationJson(phone, state ? JSON.stringify(state) : null),
    async listReminderCandidates(): Promise<ReminderLink[]> {
      const links = await dbf.listWhatsappReminderLinks();
      const out: ReminderLink[] = [];
      for (const row of links) {
        const items = await dbf.listActivePantry(row.userId);
        out.push({ ...toLinkRecord(row), items: items.map(toPantryItem) });
      }
      return out;
    },
    markReminded: (phone, localDate) => dbf.markWhatsappReminded(phone, localDate),
  };
}

function toPantryItem(e: dbf.PantryEntry): PantryItem {
  return { id: e.id, name: e.name, kind: e.kind, expiryDate: e.expiryDate };
}

// ---------------------------------------------------------------------- Services

function callerFor(user: User) {
  // The same router the website uses, called in-process as the linked user: identical validation,
  // ownership checks, LLM handling and database writes.
  return appRouter.createCaller({ user, req: { headers: {}, ip: "whatsapp" } as any, res: {} as any });
}

async function userFor(userId: string): Promise<User> {
  const user = await dbf.getUserById(Number(userId));
  if (!user) throw new Error("linked user not found");
  return user as User;
}

const toCode = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "produce";
const P_FRESH_BAND = { fresh: 85, normal: 50, rotten: 15 } as const; // only used when the classifier gave no probability

function stripTag(tag: string): string {
  return tag.replace(/^[a-z]{2}:/i, "").replace(/-/g, " ").trim();
}

async function buildPackagedReport(
  user: User,
  scanId: number,
  productName: string,
  extra: { brand?: string; allergenTags?: string[]; nutriments?: Record<string, number | null | undefined> } = {}
): Promise<PackagedReport> {
  const caller = callerFor(user);
  const { scan, ingredients } = await caller.scanner.getScan({ scanId });
  const [profile, conditions, medications] = await Promise.all([
    caller.profile.get().catch(() => null),
    caller.profile.getMedicalConditions().catch(() => []),
    caller.profile.getMedications({ currentOnly: true }).catch(() => []),
  ]);
  const alerts = evaluateHealthAlerts({
    ingredients: ingredients.map((i) => ({ name: i.name, category: i.category, riskLevel: i.riskLevel })),
    nutriments: extra.nutriments ? {
      sugars: extra.nutriments.sugars ?? null,
      salt: extra.nutriments.salt ?? null,
      saturatedFat: extra.nutriments.saturatedFat ?? null,
      fat: extra.nutriments.fat ?? null,
    } : null,
    allergensTags: extra.allergenTags ?? null,
    profile: profile ? { dietType: profile.dietType } : null,
    conditions: conditions.map((c: any) => c.condition),
    medications: medications.map((m: any) => ({ name: m.name, isCurrent: m.isCurrent, dosage: m.dosage })),
    dietType: profile?.dietType ?? null,
  });

  let healthier: PackagedReport["healthierAlternative"];
  if (isRealLLMConfigured()) {
    try {
      await caller.analysis.suggestAlternatives({ scanId, productName });
      const alt = (await caller.scanner.getScan({ scanId })).alternatives[0];
      if (alt) healthier = { name: alt.productName, brand: (alt as any).brand ?? undefined };
    } catch {
      // alternatives are optional; the report is still useful without them
    }
  }

  return {
    productName,
    brand: extra.brand,
    riskScore: scan.riskScore ?? 0,
    highRiskAdditives: ingredients.filter((i) => i.riskLevel === "high" || i.riskLevel === "severe").map((i) => i.name),
    allergens: (extra.allergenTags ?? []).map(stripTag).filter(Boolean),
    healthierAlternative: healthier,
    personalAlerts: alerts.slice(0, 6).map((a) => `${a.title}: ${a.message}`),
  };
}

async function analyzeText(user: User, text: string, productName: string, extra: Parameters<typeof buildPackagedReport>[3] = {}) {
  const caller = callerFor(user);
  const { scanId } = await caller.scanner.createScan({ productName, inputType: "text", rawIngredients: text.slice(0, 20000) });
  await caller.analysis.analyzeIngredients({ scanId, ingredients: text.slice(0, 20000) });
  return buildPackagedReport(user, scanId, productName, extra);
}

export interface ServiceDeps {
  env: WhatsappEnv;
  fetchImpl?: typeof fetch;
}

export function createWhatsappServices({ env, fetchImpl = fetch }: ServiceDeps): Services {
  return {
    async classifyImage(img: DownloadedMedia): Promise<ProduceClassification | null> {
      // A readable barcode means this is a packaged product, not produce. (The produce model has no
      // "not produce" class, so this check avoids reporting a cereal box as an apple.)
      if (decodeBarcodeFromImage(img.bytes, img.contentType)) return null;
      const form = new FormData();
      form.append("file", new Blob([img.bytes as BlobPart], { type: img.contentType }), "photo");
      const res = await fetchImpl(`${FRESHGUARD_URL()}/api/predict?persist=0`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
      if (res.status === 400) return null;
      if (!res.ok) throw new Error(`FreshGuard responded ${res.status}`);
      const d: any = await res.json();
      // The classifier flags photos that do not look like produce (energy score); do not report a fruit for those.
      if (d.is_produce === false) return null;
      return {
        fruit: String(d.fruit_kr ?? d.fruit ?? ""),
        confidence: Number(d.confidence),
        freshnessStatus: d.freshness_status,
        shelfLifeDays: Number(d.shelf_life_days),
        pFresh: Number.isFinite(Number(d.p_fresh)) ? Number(d.p_fresh) : undefined,
        storageTip: typeof d.storage_tips === "string" ? d.storage_tips : undefined,
        cookingTip: typeof d.cooking_tips === "string" ? d.cooking_tips : undefined,
      };
    },

    async classifyOrExtract(img: DownloadedMedia): Promise<ImageInterpretation> {
      const code = decodeBarcodeFromImage(img.bytes, img.contentType);
      if (code) return { kind: "barcode", barcode: code };
      // Label reading needs a real vision model. The built-in offline engine returns canned text, which must
      // never be presented as the contents of the user's photo.
      if (!isRealLLMConfigured()) return { kind: "unknown" };
      const dataUrl = `data:${img.contentType};base64,${Buffer.from(img.bytes).toString("base64")}`;
      const reply = getLLMText(
        await invokeLLM({
          messages: [
            { role: "system", content: "You read food packaging. Reply with plain text only." },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Extract the ingredient list exactly as printed on this food label, as a comma-separated list. " +
                    "If there is no readable ingredient list, reply with exactly NO_INGREDIENTS_FOUND.",
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        })
      ).trim();
      if (!reply || /NO_INGREDIENTS_FOUND/i.test(reply)) return { kind: "unknown" };
      return { kind: "label_text", text: reply };
    },

    async lookupBarcode(userId, barcode): Promise<PackagedReport | null> {
      const user = await userFor(userId);
      const caller = callerFor(user);
      const product = await caller.openFoodFacts.getByBarcode({ barcode });
      if (!product) return null;
      const allergens = (product.allergens ?? []) as string[];
      if (!product.ingredientsText?.trim()) {
        return {
          productName: product.productName,
          brand: product.brand || undefined,
          riskScore: 0,
          highRiskAdditives: [],
          allergens: allergens.map(stripTag),
          personalAlerts: [],
          noIngredientData: true,
        };
      }
      return analyzeText(user, product.ingredientsText, product.productName, {
        brand: product.brand || undefined,
        allergenTags: allergens,
        nutriments: product.nutriments as any,
      });
    },

    async analyzeIngredientsText(userId, text) {
      return analyzeText(await userFor(userId), text, "WhatsApp scan");
    },

    async listPantry(userId) {
      return (await dbf.listActivePantry(Number(userId))).map(toPantryItem);
    },

    async addPantryItem(userId, item: NewPantryItem) {
      const caller = callerFor(await userFor(userId));
      if (item.kind === "produce") {
        const status = item.freshnessStatus ?? "normal";
        const { id } = await caller.produce.addInventory({
          name: item.name.slice(0, 100),
          fruit: toCode(item.name).slice(0, 64),
          freshness: status,
          pFresh: item.pFresh ?? P_FRESH_BAND[status],
          confidence: item.confidence ?? 0,
          imageUrl: "",
          storageTip: item.storageTip,
          expiryDate: item.expiryDate,
        });
        return { id: `produce:${id}` };
      }
      const { id } = await caller.inventory.add({
        title: item.name,
        category: "Other",
        quantity: "1",
        storageLocation: "fridge",
        expiryDate: item.expiryDate,
        notes: `Added via WhatsApp (${item.source})`,
      });
      return { id: `packaged:${id}` };
    },

    async clearPantryItem(userId, itemId) {
      if (!(await dbf.clearPantryEntry(Number(userId), itemId))) throw new Error("item not found");
    },

    async rescueRecipes(userId, _expiring): Promise<Recipe[]> {
      const caller = callerFor(await userFor(userId));
      const out = await caller.rescue.recipes({ windowDays: 3, utcOffsetMinutes: 0 });
      return out.recipes.map((r) => ({
        title: r.title,
        summary: `${r.timeMinutes} min. ${r.steps.join(" ")}`.slice(0, 600),
        usesItems: r.usesItems,
      }));
    },

    async linkAccount(code, phone): Promise<LinkResult> {
      const now = Date.now();
      const rows = await dbf.listRedeemableLinkCodes(new Date(now));
      const records = rows.map((r) => ({
        id: r.id,
        userId: String(r.userId),
        salt: r.salt,
        codeHash: r.codeHash,
        expiresAt: r.expiresAt.getTime(),
        usedAt: r.usedAt ? r.usedAt.getTime() : null,
      }));
      const match = findMatchingLinkRecord(records, code, now);
      if (!match || match.status === "invalid") {
        return { ok: false, reason: "invalid" };
      }
      if (match.status !== "ok") return { ok: false, reason: match.status };
      // Re-check and consume atomically: only one redemption can win.
      if (checkLinkCode(match.record, code, now) !== "ok" || !(await dbf.consumeLinkCode(match.record.id, new Date(now)))) {
        return { ok: false, reason: "used" };
      }
      await dbf.linkWhatsappAccount(Number(match.record.userId), phone);
      const user = await dbf.getUserById(Number(match.record.userId));
      return { ok: true, userId: match.record.userId, displayName: user?.name ?? undefined };
    },

    async getReminderPrefs(userId): Promise<ReminderPrefs> {
      const link = await dbf.getWhatsappLinkByUser(Number(userId));
      if (!link) throw new Error("not linked");
      return { enabled: link.remindersEnabled, hour: link.reminderHour, timezone: link.timezone };
    },

    async setReminderPrefs(userId, patch): Promise<ReminderPrefs> {
      await dbf.updateWhatsappPrefsByUser(Number(userId), {
        remindersEnabled: patch.enabled,
        reminderHour: patch.hour,
        timezone: patch.timezone,
      });
      return this.getReminderPrefs(userId);
    },

    async downloadMedia(media: MediaRef): Promise<DownloadedMedia> {
      if (media.provider === "twilio" && env.twilio) {
        return downloadTwilioMedia({ media, accountSid: env.twilio.accountSid, authToken: env.twilio.authToken, fetchImpl });
      }
      if (media.provider === "meta" && env.meta) {
        return downloadMetaMedia({ media, accessToken: env.meta.accessToken, fetchImpl });
      }
      throw new Error(`provider ${media.provider} is not configured`);
    },
  };
}

// ------------------------------------------------------------------------ Wiring

export function createSender(env: WhatsappEnv, provider: Provider): Sender | null {
  if (provider === "twilio" && env.twilio) {
    return createTwilioSender({
      accountSid: env.twilio.accountSid,
      authToken: env.twilio.authToken,
      fromNumber: env.twilio.fromNumber,
      contentSids: env.twilio.contentSids,
    });
  }
  if (provider === "meta" && env.meta) {
    return createMetaSender({ accessToken: env.meta.accessToken, phoneNumberId: env.meta.phoneNumberId });
  }
  return null;
}

/** Provider used for proactive messages (reminders). WHATSAPP_PROVIDER decides when both are configured. */
export function reminderProvider(env: WhatsappEnv, preferred = process.env.WHATSAPP_PROVIDER): Provider | null {
  if (preferred === "meta" && env.meta) return "meta";
  if (preferred === "twilio" && env.twilio) return "twilio";
  if (env.twilio) return "twilio";
  if (env.meta) return "meta";
  return null;
}

function botConfig(env: WhatsappEnv): BotConfig {
  return {
    webAppUrl: env.publicBaseUrl || "the web app",
    useEmoji: env.useEmoji,
    reminderTemplate: env.reminderTemplate,
    // The produce model always picks one of its 10 classes, so a low-confidence guess on a random photo is
    // likely wrong. A higher bar than the 50% default keeps the bot honest.
    minConfidence: 70,
  };
}

/** Per-phone limiter. Default: burst of 8, then one message every 6 s. WHATSAPP_RATE_BURST / WHATSAPP_RATE_PER_MINUTE override. */
function createRateLimiter(e: NodeJS.ProcessEnv = process.env) {
  const burst = Number(e.WHATSAPP_RATE_BURST);
  if (!Number.isFinite(burst) || burst < 1) return createDefaultRateLimiter();
  const perMinute = Number(e.WHATSAPP_RATE_PER_MINUTE);
  return new TokenBucketLimiter({ capacity: Math.floor(burst), refillPerSec: (perMinute > 0 ? perMinute : 10) / 60 });
}

export function createHandlerDeps(env: WhatsappEnv = getWhatsappEnv()): HandlerDeps {
  return {
    store: createWhatsappStore(),
    services: createWhatsappServices({ env }),
    config: botConfig(env),
    rateLimiter: createRateLimiter(),
    linkLimiter: new AttemptLimiter(),
    log,
  };
}

/**
 * Mounts POST /api/whatsapp/twilio, POST+GET /api/whatsapp/meta. Call BEFORE express.json(): signature
 * checks need the exact raw bytes. Routes answer 503 until the provider's credentials are configured.
 */
export function registerWhatsappRoutes(app: Express, depsOverride?: HandlerDeps) {
  // TRUST_PROXY is applied once at startup by configureTrustProxy (index.ts). Do not re-parse it here: this used to
  // turn TRUST_PROXY=0 into 1 hop and a subnet list such as "loopback" into 1 hop, letting clients spoof X-Forwarded-For.
  const env = getWhatsappEnv();
  const deps = depsOverride ?? createHandlerDeps(env);

  app.post("/api/whatsapp/twilio", express.text({ type: "application/x-www-form-urlencoded", limit: "200kb" }), async (req: Request, res: Response) => {
    if (!env.twilio) return void res.status(503).type("text/plain").send("Twilio WhatsApp is not configured");
    if (!env.publicBaseUrl) return void res.status(503).type("text/plain").send("PUBLIC_BASE_URL is required to verify Twilio signatures");
    try {
      const sender = createSender(env, "twilio")!;
      const result = await processTwilioWebhook(
        { url: env.publicBaseUrl + req.originalUrl, formBody: typeof req.body === "string" ? req.body : "", headers: req.headers },
        { ...deps, twilio: { authToken: env.twilio.authToken, allowSchemeVariants: env.allowSchemeVariants } }
      );
      res.status(result.status).type(result.contentType).send(result.body);
      void deliver(sender, result.outbound, log);
    } catch (err) {
      log("error", "twilio_webhook_failed", { error: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) res.status(200).type("text/xml").send("<Response></Response>");
    }
  });

  app.get("/api/whatsapp/meta", async (req: Request, res: Response) => {
    if (!env.meta) return void res.status(503).type("text/plain").send("Meta WhatsApp is not configured");
    const result = await processMetaWebhook(
      { headers: req.headers, query: req.query as Record<string, string | string[] | undefined>, method: "GET" },
      { ...deps, meta: { appSecret: env.meta.appSecret, verifyToken: env.meta.verifyToken } }
    );
    res.status(result.status).type(result.contentType).send(result.body);
  });

  app.post("/api/whatsapp/meta", express.raw({ type: "application/json", limit: "2mb" }), async (req: Request, res: Response) => {
    if (!env.meta) return void res.status(503).type("text/plain").send("Meta WhatsApp is not configured");
    try {
      const sender = createSender(env, "meta")!;
      const result = await processMetaWebhook(
        { rawBody: Buffer.isBuffer(req.body) ? req.body : new Uint8Array(), headers: req.headers, query: {}, method: "POST" },
        { ...deps, meta: { appSecret: env.meta.appSecret, verifyToken: env.meta.verifyToken } }
      );
      res.status(result.status).type(result.contentType).send(result.body);
      void deliver(sender, result.outbound, log);
    } catch (err) {
      log("error", "meta_webhook_failed", { error: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) res.status(200).type("text/plain").send("ok");
    }
  });
}

/** Daily expiry reminders. Checks every 10 minutes (configurable); each user is notified at most once per local day. */
export function startReminderScheduler(depsOverride?: HandlerDeps): (() => void) | null {
  const env = getWhatsappEnv();
  const provider = reminderProvider(env);
  if (!env.remindersEnabled || !provider) return null;
  const sender = createSender(env, provider);
  if (!sender) return null;
  const deps = depsOverride ?? createHandlerDeps(env);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReminders({ store: deps.store, sender, config: botConfig(env), log });
      if (r.due > 0) log("info", "reminders_run", r);
    } catch (err) {
      log("error", "reminders_failed", { error: err instanceof Error ? err.name : "unknown" });
    } finally {
      running = false;
    }
  };
  // Default every 10 minutes; WHATSAPP_REMINDER_INTERVAL_MS (>= 1000) shortens it for tests.
  const configured = Number(process.env.WHATSAPP_REMINDER_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured) && configured >= 1000 ? configured : 10 * 60 * 1000;
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log("info", "reminder_scheduler_started", { provider });
  return () => clearInterval(timer);
}

export { isWhatsappConfigured };
