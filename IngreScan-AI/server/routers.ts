import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { insightsRouter, rescueRouter, whatsappRouter } from "./featureRouters";
import { qcRouter, receiptRouter } from "./opsRouters";
import { householdRouter } from "./householdRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { storagePut } from "./storage";
import { ownerIdFromName } from "./uploads";
import { invokeLLM } from "./_core/llm";
import fs from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { ALT_MARKET_ATTRIBUTION, allowAltMarketCall, countryFromRegion, lookupAlternativeMarket } from "./lib/altMarket";
import { fetchOffProduct, isWellFormedBarcode, searchOffProducts } from "./lib/offClient";
import {
  clampRiskScore,
  computeBmi,
  computeExpiry,
  firstCategory,
  isValidYmd,
  getLLMText,
  normalizeGrade,
  normalizeNova,
  parseAllergens,
  parseLLMJson,
  parseTimestampInput,
  sanitizeAlternative,
  sanitizeFileName,
  sanitizeIngredient,
} from "./logic";

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Look up a scan owned by the caller or throw NOT_FOUND (prevents cross-user access). */
async function requireOwnedScan(scanId: number, userId: number) {
  const scan = await db.getFoodScan(scanId, userId);
  if (!scan) throw new TRPCError({ code: "NOT_FOUND", message: "Scan not found" });
  return scan;
}

/** Serialises "replace derived rows" work per scan so overlapping requests (double submit) cannot interleave and duplicate rows. */
const scanLocks = new Map<number, Promise<unknown>>();
async function withScanLock<T>(scanId: number, fn: () => Promise<T>): Promise<T> {
  const prev = scanLocks.get(scanId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  scanLocks.set(scanId, tail);
  try {
    return await run;
  } finally {
    if (scanLocks.get(scanId) === tail) scanLocks.delete(scanId);
  }
}

/** Models sometimes return the bare array the prompt describes instead of the wrapper object. */
function listFromLLM(parsed: any, key: string): any[] {
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.[key]) ? parsed[key] : [];
}

/** Produce images are served from this app's own /static (uploads or bundled samples); no external URLs. */
const produceImageUrl = z
  .string()
  .max(512)
  .regex(/^\/static\/(uploads|samples)\/[A-Za-z0-9._-]+$/, "Invalid image path")
  .or(z.literal(""))
  .optional();

/** Whole calendar days from today (UTC date) to a YYYY-MM-DD expiry; negative once expired. */
function produceDaysLeft(expiryDate: string, now: Date = new Date()): number {
  const target = Date.parse(`${expiryDate}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Number.isNaN(target) ? 0 : Math.round((target - today) / 86_400_000);
}

// Row shapes keep the snake_case field names the Produce page already renders.
function toProduceInventoryRow(r: db.ProduceInventoryRow) {
  return {
    id: r.id,
    name: r.name,
    fruit_type: r.fruitType,
    freshness: r.freshness,
    p_fresh: r.pFresh,
    confidence: r.confidence,
    image_url: r.imageUrl ?? "",
    expiry_date: r.expiryDate,
    days_left: produceDaysLeft(r.expiryDate),
    storage_tip: r.storageTip ?? "",
    created_at: r.createdAt.toISOString(),
  };
}

function toProduceScanRow(r: db.ProduceScanRow) {
  return {
    id: r.id,
    fruit_type: r.fruitType,
    fruit_name_kr: r.fruitName,
    freshness: r.freshness,
    freshness_kr: r.freshnessLabel,
    p_fresh: r.pFresh,
    confidence: r.confidence,
    image_url: r.imageUrl ?? "",
    created_at: r.createdAt.toISOString(),
  };
}

/** Parse a date input for a TIMESTAMP column or throw BAD_REQUEST. */
function requireDate(value: string | Date): Date {
  const d = parseTimestampInput(value);
  if (!d) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid date" });
  return d;
}

/** Local uploads are stored as relative /uploads/... URLs the LLM cannot fetch; inline them. */
async function resolveImageForLLM(url: string, userId?: number): Promise<string> {
  if (!url.startsWith("/uploads/")) return url;
  const baseName = path.basename(url);
  if (userId !== undefined && ownerIdFromName(baseName) !== userId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
  }
  const uploadsDir = path.resolve(process.cwd(), "uploads");
  const file = path.resolve(uploadsDir, baseName);
  if (path.dirname(file) !== uploadsDir) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid image URL" });
  try {
    const buf = await fs.promises.readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext || "png";
    return `data:image/${mime};base64,${buf.toString("base64")}`;
  } catch {
    throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
  }
}


// ============= Input Schemas =============

// null clears a stored value; undefined leaves it unchanged.
const userProfileSchema = z.object({
  age: z.number().int().min(0).max(130).nullable().optional(),
  gender: z.enum(["male", "female", "other"]).nullable().optional(),
  height: z.number().int().min(30).max(300).nullable().optional(), // cm (int column)
  weight: z.number().int().min(1).max(700).nullable().optional(), // kg (int column)
  bmi: z.number().min(0).max(200).nullable().optional(),
  exerciseFrequency: z.enum(["sedentary", "light", "moderate", "active", "very_active"]).nullable().optional(),
  dietType: z.enum(["veg", "non_veg", "vegan", "keto", "other"]).nullable().optional(),
  // Country or city; lets the AI suggest brands that are actually sold near the user. Empty string clears it.
  region: z.string().trim().max(64).optional(),
});

/** TIMESTAMP columns (MySQL) only hold 1970-2038; out-of-range dates would otherwise surface as a 500 from the driver. */
const timestampDate = z.date().refine((d) => parseTimestampInput(d) !== null, "Date is out of the supported range");

const medicalConditionSchema = z.object({
  condition: z.string().trim().min(1).max(2000),
  diagnosedDate: timestampDate.optional(),
  notes: z.string().max(5000).optional(),
});

const medicationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  dosage: z.string().max(100).optional(),
  frequency: z.string().max(100).optional(),
  startDate: timestampDate.optional(),
  endDate: timestampDate.optional(),
  isCurrent: z.boolean().default(true),
  notes: z.string().max(5000).optional(),
});

// Zod 4 applies .default() even inside .partial(), which would silently reset isCurrent to true
// on every partial update. Use an explicit optional instead.
const medicationUpdateSchema = medicationSchema.extend({ isCurrent: z.boolean().optional() }).partial();

const createScanSchema = z.object({
  productName: z.string().max(255).optional(),
  inputType: z.enum(["text", "image"]),
  rawIngredients: z.string().max(20000).optional(),
  imageUrl: z.string().max(2000).optional(),
  imageKey: z.string().max(2000).optional(),
});

const createInventoryItemSchema = z.object({
  title: z.string().trim().min(1).max(255),
  category: z.string().max(100).default("Other"),
  quantity: z.string().max(100).default("1"),
  storageLocation: z.enum(["fridge", "freezer", "pantry"]).default("fridge"),
  foodImageUrl: z.string().max(2000).optional(),
  barcode: z.string().max(64).optional(),
  expiryDate: z.string().or(z.date()),
  notes: z.string().max(5000).optional(),
});

const updateInventoryItemSchema = z.object({
  id: z.number().int(),
  title: z.string().trim().min(1).max(255).optional(),
  category: z.string().max(100).optional(),
  quantity: z.string().max(100).optional(),
  storageLocation: z.enum(["fridge", "freezer", "pantry"]).optional(),
  foodImageUrl: z.string().max(2000).optional(),
  expiryDate: z.string().or(z.date()).optional(),
  notes: z.string().max(5000).optional(),
  status: z.enum(["fresh", "expiring_soon", "expired", "consumed"]).optional(),
});

// ============= Router Definition =============

export const appRouter = router({
  system: systemRouter,
  
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ============= User Profile Router =============
  profile: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      return db.getUserProfile(ctx.user.id);
    }),

    upsert: protectedProcedure
      .input(userProfileSchema)
      .mutation(async ({ ctx, input }) => {
        // Calculate BMI if height and weight provided
        // A partial update (only weight, or only height) must use the stored other half, otherwise BMI goes stale.
        let bmi = input.bmi;
        if (bmi === undefined && (input.height !== undefined || input.weight !== undefined)) {
          const existing = await db.getUserProfile(ctx.user.id);
          const height = input.height === undefined ? existing?.height : input.height;
          const weight = input.weight === undefined ? existing?.weight : input.weight;
          // Clearing height or weight also clears the now-meaningless BMI.
          bmi = computeBmi(height, weight) ?? null;
        }

        return db.upsertUserProfile({
          userId: ctx.user.id,
          ...input,
          region: input.region === undefined ? undefined : input.region || null,
          bmi,
        });
      }),

    getMedicalConditions: protectedProcedure.query(async ({ ctx }) => {
      return db.getMedicalConditions(ctx.user.id);
    }),

    addMedicalCondition: protectedProcedure
      .input(medicalConditionSchema)
      .mutation(async ({ ctx, input }) => {
        return db.addMedicalCondition({
          userId: ctx.user.id,
          ...input,
        });
      }),

    deleteMedicalCondition: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const count = await db.deleteMedicalCondition(input.id, ctx.user.id);
        if (!count) throw new TRPCError({ code: "NOT_FOUND", message: "Medical condition not found" });
        return { success: true };
      }),

    getMedications: protectedProcedure
      .input(z.object({ currentOnly: z.boolean().default(false) }))
      .query(async ({ ctx, input }) => {
        return db.getMedications(ctx.user.id, input.currentOnly);
      }),

    addMedication: protectedProcedure
      .input(medicationSchema)
      .mutation(async ({ ctx, input }) => {
        return db.addMedication({
          userId: ctx.user.id,
          ...input,
        });
      }),

    updateMedication: protectedProcedure
      .input(z.object({
        id: z.number(),
        updates: medicationUpdateSchema,
      }))
      .mutation(async ({ ctx, input }) => {
        const count = await db.updateMedication(input.id, ctx.user.id, input.updates);
        if (!count) throw new TRPCError({ code: "NOT_FOUND", message: "Medication not found" });
        return { success: true };
      }),

    deleteMedication: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const count = await db.deleteMedication(input.id, ctx.user.id);
        if (!count) throw new TRPCError({ code: "NOT_FOUND", message: "Medication not found" });
        return { success: true };
      }),
  }),

  // ============= Scanner Router =============
  scanner: router({
    uploadImage: protectedProcedure
      .input(z.object({
        fileName: z.string(),
        fileData: z.string(), // base64
        mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/, "Only image uploads are allowed"),
      }))
      .mutation(async ({ ctx, input }) => {
        const buffer = Buffer.from(input.fileData, 'base64');
        if (buffer.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Empty file" });
        if (buffer.length > MAX_UPLOAD_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "File too large (max 16MB)" });
        const fileKey = `scans/${ctx.user.id}/${Date.now()}-${randomBytes(8).toString("hex")}-${sanitizeFileName(input.fileName)}`;
        const { url } = await storagePut(fileKey, buffer, input.mimeType);
        return { url, fileKey };
      }),

    createScan: protectedProcedure
      .input(createScanSchema)
      .mutation(async ({ ctx, input }) => {
        const scanId = await db.createFoodScan({
          userId: ctx.user.id,
          ...input,
        });
        if (!scanId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create scan" });
        return { scanId };
      }),

    getScan: protectedProcedure
      .input(z.object({ scanId: z.number() }))
      .query(async ({ ctx, input }) => {
        const scan = await requireOwnedScan(input.scanId, ctx.user.id);
        
        const ingredients = await db.getScanIngredients(input.scanId);
        const alternatives = await db.getAlternatives(input.scanId);
        
        return { scan, ingredients, alternatives };
      }),

    getUserScans: protectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
      .query(async ({ ctx, input }) => {
        return db.getUserScans(ctx.user.id, input.limit);
      }),

    processOCR: protectedProcedure
      .input(z.object({
        scanId: z.number().int(),
        imageUrl: z.string().min(1).max(2000),
      }))
      .mutation(async ({ ctx, input }) => {
        await requireOwnedScan(input.scanId, ctx.user.id);
        const imageUrl = await resolveImageForLLM(input.imageUrl, ctx.user.id);
        // Use LLM with vision to extract ingredients from image
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: "You are an expert at reading food ingredient labels. Extract all ingredients from the image and return them as a comma-separated list."
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Please extract all ingredients from this food label image:"
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageUrl,
                    detail: "high"
                  }
                }
              ]
            }
          ],
        });

        const ocrText = getLLMText(response).trim();
        if (!ocrText) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not extract ingredients from the image" });
        
        // Update scan with OCR results
        await db.updateFoodScan(input.scanId, ctx.user.id, {
          ocrText,
          rawIngredients: ocrText,
        });

        return { ocrText };
      }),

    deleteScan: protectedProcedure
      .input(z.object({ scanId: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwnedScan(input.scanId, ctx.user.id);
        await db.deleteScanIngredients(input.scanId);
        await db.deleteAlternatives(input.scanId);
        await db.deleteFoodScan(input.scanId, ctx.user.id);
        return { success: true };
      }),
  }),

  // ============= Analysis Router =============
  analysis: router({
    analyzeIngredients: protectedProcedure
      .input(z.object({
        scanId: z.number().int(),
        ingredients: z.string().trim().min(1, "Ingredients are required").max(20000),
      }))
      .mutation(async ({ ctx, input }) => {
        await requireOwnedScan(input.scanId, ctx.user.id);
        // Get user profile for personalized analysis
        const userProfile = await db.getUserProfile(ctx.user.id);
        const medicalConditions = await db.getMedicalConditions(ctx.user.id);
        const medications = await db.getMedications(ctx.user.id, true);

        // Build context for LLM
        const userContext = {
          profile: userProfile,
          conditions: medicalConditions.map(c => c.condition),
          medications: medications.map(m => m.name),
        };

        // Use LLM to analyze ingredients with Label Padhega India focus
        const analysisPrompt = `Analyze the following food ingredients for health risks, with special focus on consumer awareness and the "Label Padhega India" campaign principles.

User Context:
${JSON.stringify(userContext, null, 2)}

Ingredients:
${input.ingredients}

For each ingredient, provide:
1. Scientific name (if applicable)
2. Category (preservative, sweetener, flavor enhancer, etc.)
3. Risk level (safe, low, moderate, high, severe)
4. Short-term effects
5. Long-term effects
6. Side effects
7. Personalized risk based on user profile
8. Sources (cite WHO, FSSAI, PubMed when applicable)

IMPORTANT - Label Padhega India Focus:
- Identify hidden sugars (including maltodextrin, corn syrup, dextrose, etc.)
- Flag excessive salt/sodium content
- Highlight unhealthy oils and trans fats
- Detect harmful additives and preservatives (E-numbers, artificial colors, etc.)
- Identify misleading marketing claims (e.g., "healthy", "natural", "sugar-free" but high in other sweeteners)
- Special attention to products marketed to children
- Educate about ingredient order (ingredients listed by quantity)

Return the analysis with consumer education focus as a JSON array with this structure:
[{
  "name": "ingredient name",
  "scientificName": "scientific name",
  "category": "category",
  "riskLevel": "safe|low|moderate|high|severe",
  "shortTermEffects": "description",
  "longTermEffects": "description",
  "sideEffects": "description",
  "personalizedRisk": "personalized analysis",
  "sources": ["source1", "source2"]
}]`;

        const response = await invokeLLM({
          messages: [
            { role: "system", content: "You are a food safety and nutrition expert with knowledge of FSSAI and WHO guidelines." },
            { role: "user", content: analysisPrompt }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "ingredient_analysis",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  ingredients: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        scientificName: { type: "string" },
                        category: { type: "string" },
                        riskLevel: { type: "string", enum: ["safe", "low", "moderate", "high", "severe"] },
                        shortTermEffects: { type: "string" },
                        longTermEffects: { type: "string" },
                        sideEffects: { type: "string" },
                        personalizedRisk: { type: "string" },
                        sources: { type: "array", items: { type: "string" } }
                      },
                      required: ["name", "scientificName", "category", "riskLevel", "shortTermEffects", "longTermEffects", "sideEffects", "personalizedRisk", "sources"],
                      additionalProperties: false
                    }
                  },
                  overallRiskScore: { type: "number" },
                  summary: { type: "string" }
                },
                required: ["ingredients", "overallRiskScore", "summary"],
                additionalProperties: false
              }
            }
          }
        });

        let analysisResult: any;
        try {
          analysisResult = parseLLMJson(getLLMText(response));
        } catch (err) {
          console.error("[Analysis] Unparseable LLM response:", err);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI analysis returned an invalid response. Please try again." });
        }
        const parsedIngredients = listFromLLM(analysisResult, "ingredients")
          .map(sanitizeIngredient)
          .filter((i: any): i is NonNullable<typeof i> => i !== null);
        if (parsedIngredients.length === 0) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI analysis returned no ingredients. Please try again." });
        }

        // Replace any previous analysis so re-running does not duplicate rows
        await withScanLock(input.scanId, async () => {
          await db.deleteScanIngredients(input.scanId);
          for (const ingredient of parsedIngredients) {
            await db.addScanIngredient({ scanId: input.scanId, ...ingredient });
          }
        });

        // Update scan with risk score
        await db.updateFoodScan(input.scanId, ctx.user.id, {
          riskScore: clampRiskScore(analysisResult?.overallRiskScore),
          analysisComplete: true,
        });

        return analysisResult;
      }),

    /** Real community price/availability data (Open Food Facts + Open Prices) for a scan's alternatives. Never throws on upstream failure. */
    alternativeMarket: protectedProcedure
      .input(z.object({ scanId: z.number().int() }))
      .query(async ({ ctx, input }) => {
        await requireOwnedScan(input.scanId, ctx.user.id);
        if (!allowAltMarketCall(ctx.user.id)) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many price lookups. Please wait a minute and try again." });
        }
        const [alternatives, profile] = await Promise.all([db.getAlternatives(input.scanId), db.getUserProfile(ctx.user.id)]);
        const country = countryFromRegion(profile?.region);
        const items = await Promise.all(alternatives.slice(0, 8).map((a) => lookupAlternativeMarket(a, country)));
        return { country, items, attribution: ALT_MARKET_ATTRIBUTION };
      }),

    suggestAlternatives: protectedProcedure
      .input(z.object({
        scanId: z.number().int(),
        productName: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        const scan = await requireOwnedScan(input.scanId, ctx.user.id);

        const ingredients = await db.getScanIngredients(input.scanId);
        const userProfile = await db.getUserProfile(ctx.user.id);

        const prompt = `Suggest 3-5 healthier alternatives to "${input.productName}" based on the ingredient analysis and user profile.

User Profile: ${JSON.stringify(userProfile)}
Current Product Risk Score: ${scan.riskScore}
Problematic Ingredients: ${ingredients.filter(i => i.riskLevel && ['moderate', 'high', 'severe'].includes(i.riskLevel)).map(i => i.name).join(', ')}

User region: ${userProfile?.region || "not provided"}

For each alternative, provide:
1. Product name
2. Brand: a specific commercial brand${userProfile?.region ? ` that is sold in ${userProfile.region}` : ""}, only if you are confident it exists and fits; otherwise an empty string. Never invent a brand, a price or store availability.
3. Reason why it's better
4. Scientific justification
5. Sources

Return as JSON array:
[{
  "productName": "alternative product",
  "brand": "brand name or empty string",
  "reason": "why it's better",
  "scientificJustification": "detailed explanation",
  "sources": ["source1", "source2"]
}]`;

        const response = await invokeLLM({
          messages: [
            { role: "system", content: "You are a nutrition expert who recommends healthier food alternatives." },
            { role: "user", content: prompt }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "alternatives",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  alternatives: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        productName: { type: "string" },
                        brand: { type: "string" },
                        reason: { type: "string" },
                        scientificJustification: { type: "string" },
                        sources: { type: "array", items: { type: "string" } }
                      },
                      required: ["productName", "brand", "reason", "scientificJustification", "sources"],
                      additionalProperties: false
                    }
                  }
                },
                required: ["alternatives"],
                additionalProperties: false
              }
            }
          }
        });

        let result: any;
        try {
          result = parseLLMJson(getLLMText(response));
        } catch (err) {
          console.error("[Alternatives] Unparseable LLM response:", err);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned an invalid response. Please try again." });
        }
        const alts = listFromLLM(result, "alternatives")
          .map(sanitizeAlternative)
          .filter((a: any): a is NonNullable<typeof a> => a !== null);

        // Replace previous suggestions so repeated requests do not pile up duplicates
        if (alts.length > 0) {
          await withScanLock(input.scanId, async () => {
            await db.deleteAlternatives(input.scanId);
            for (const alt of alts) {
              await db.addAlternative({ scanId: input.scanId, ...alt });
            }
          });
        }

        return alts;
      }),
  }),

  // ============= Chatbot Router =============
  chat: router({
    sendMessage: protectedProcedure
      .input(z.object({
        message: z.string().trim().min(1).max(4000),
        scanId: z.number().int().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Verify scan ownership first (otherwise another user's scan data leaks into the prompt)
        const scan = input.scanId !== undefined ? await requireOwnedScan(input.scanId, ctx.user.id) : undefined;

        // Save user message
        await db.addChatMessage({
          userId: ctx.user.id,
          scanId: input.scanId,
          role: "user",
          content: input.message,
        });

        // Get chat history for context
        const history = await db.getChatHistory(ctx.user.id, input.scanId, 20);
        
        // Get user context
        const userProfile = await db.getUserProfile(ctx.user.id);
        const medicalConditions = await db.getMedicalConditions(ctx.user.id);
        const medications = await db.getMedications(ctx.user.id, true);

        // Get scan context if provided
        let scanContext = "";
        if (input.scanId !== undefined) {
          const ingredients = await db.getScanIngredients(input.scanId);
          scanContext = `\n\nCurrent Scan Context:\nProduct: ${scan?.productName || 'Unknown'}\nIngredients: ${ingredients.map(i => i.name).join(', ')}`;
        }

        const systemPrompt = `You are a food safety and nutrition expert chatbot supporting the "Label Padhega India" consumer awareness movement. You ONLY answer questions about food, ingredients, nutrition, and health impacts of food products.

User Profile:
- Diet Type: ${userProfile?.dietType || 'Not specified'}
- Medical Conditions: ${medicalConditions.map(c => c.condition).join(', ') || 'None'}
- Current Medications: ${medications.map(m => m.name).join(', ') || 'None'}
${scanContext}

Guidelines:
1. Only answer food-related questions
2. Provide scientific explanations when discussing ingredients
3. Consider the user's profile in your responses
4. Cite sources (WHO, FSSAI, PubMed) when making health claims
5. If asked about non-food topics, politely redirect to food-related queries

Label Padhega India Focus:
- Educate about hidden ingredients (sugars, salts, oils, additives)
- Expose misleading marketing claims ("healthy", "natural", "sugar-free")
- Explain how to read ingredient labels properly
- Highlight risks in products marketed to children
- Empower consumers to make informed choices
- Promote food literacy and transparency

Be helpful, accurate, educational, and personalized to the user's health profile.`;

        // Build message history for LLM
        const messages = [
          { role: "system" as const, content: systemPrompt },
          ...history.slice(-10).map(h => ({
            role: h.role as "user" | "assistant",
            content: h.content,
          })),
        ];

        const response = await invokeLLM({ messages });
        const assistantMessage = getLLMText(response).trim();
        if (!assistantMessage) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned an empty response. Please try again." });

        // Save assistant message
        await db.addChatMessage({
          userId: ctx.user.id,
          scanId: input.scanId,
          role: "assistant",
          content: assistantMessage,
        });

        return { message: assistantMessage };
      }),

    getHistory: protectedProcedure
      .input(z.object({
        scanId: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }))
      .query(async ({ ctx, input }) => {
        return db.getChatHistory(ctx.user.id, input.scanId, input.limit);
      }),
  }),

  // ============= FreshGuard produce: per-user pantry + scan history =============
  // The Flask service only classifies images; persistence happens here, scoped to the signed-in user.
  produce: router({
    listInventory: protectedProcedure.query(async ({ ctx }) => {
      const rows = await db.listProduceInventory(ctx.user.id);
      return rows.map(toProduceInventoryRow);
    }),

    addInventory: protectedProcedure
      .input(z.object({
        name: z.string().trim().min(1).max(100),
        fruit: z.string().trim().min(1).max(64),
        freshness: z.enum(["fresh", "normal", "rotten"]),
        pFresh: z.number().min(0).max(100),
        confidence: z.number().min(0).max(100),
        imageUrl: produceImageUrl,
        expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expiry must be YYYY-MM-DD"),
        storageTip: z.string().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (!isValidYmd(input.expiryDate)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid expiry date" });
        }
        const id = await db.addProduceInventoryItem({
          userId: ctx.user.id,
          name: input.name,
          fruitType: input.fruit,
          freshness: input.freshness,
          pFresh: input.pFresh,
          confidence: input.confidence,
          imageUrl: input.imageUrl || null,
          expiryDate: input.expiryDate,
          storageTip: input.storageTip ?? null,
        });
        return { id };
      }),

    deleteInventory: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const deleted = await db.deleteProduceInventoryItem(input.id, ctx.user.id);
        if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
        return { success: true };
      }),

    listHistory: protectedProcedure.query(async ({ ctx }) => {
      const rows = await db.listProduceScans(ctx.user.id, 50);
      return rows.map(toProduceScanRow);
    }),

    recordScan: protectedProcedure
      .input(z.object({
        fruit: z.string().trim().min(1).max(64),
        fruitName: z.string().trim().min(1).max(100),
        freshness: z.enum(["fresh", "normal", "rotten"]),
        freshnessLabel: z.string().trim().min(1).max(64),
        pFresh: z.number().min(0).max(100),
        confidence: z.number().min(0).max(100),
        imageUrl: produceImageUrl,
      }))
      .mutation(async ({ ctx, input }) => {
        const id = await db.addProduceScan({
          userId: ctx.user.id,
          fruitType: input.fruit,
          fruitName: input.fruitName,
          freshness: input.freshness,
          freshnessLabel: input.freshnessLabel,
          pFresh: input.pFresh,
          confidence: input.confidence,
          imageUrl: input.imageUrl || null,
        });
        return { id };
      }),

    clearHistory: protectedProcedure.mutation(async ({ ctx }) => {
      await db.clearProduceScans(ctx.user.id);
      return { success: true };
    }),
  }),

  // ============= Food Expiry Tracker Router (EcoFridge Integration) =============
  inventory: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const items = await db.getUserInventory(ctx.user.id);
      const now = new Date();
      return items.map((item) => {
        const { daysLeft, status } = computeExpiry(item.expiryDate, now);
        if (item.status === "consumed") {
          return { ...item, daysLeft };
        }
        return { ...item, daysLeft, status };
      });
    }),

    add: protectedProcedure
      .input(createInventoryItemSchema)
      .mutation(async ({ ctx, input }) => {
        const expDate = requireDate(input.expiryDate);
        const { status } = computeExpiry(expDate);

        const id = await db.addInventoryItem({
          userId: ctx.user.id,
          title: input.title,
          category: input.category,
          quantity: input.quantity || "1",
          storageLocation: input.storageLocation || "fridge",
          foodImageUrl: input.foodImageUrl || null,
          barcode: input.barcode || null,
          expiryDate: expDate,
          addedDate: new Date(),
          notes: input.notes || null,
          status,
        });
        return { id, success: true };
      }),

    update: protectedProcedure
      .input(updateInventoryItemSchema)
      .mutation(async ({ ctx, input }) => {
        const { id, expiryDate, ...rest } = input;
        const updates: any = { ...rest };
        if (expiryDate) {
          updates.expiryDate = requireDate(expiryDate);
        }
        const count = await db.updateInventoryItem(id, ctx.user.id, updates);
        if (!count) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory item not found" });
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const count = await db.deleteInventoryItem(input.id, ctx.user.id);
        if (!count) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory item not found" });
        return { success: true };
      }),

    consume: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const count = await db.updateInventoryItem(input.id, ctx.user.id, { status: "consumed" });
        if (!count) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory item not found" });
        return { success: true };
      }),
  }),

  // ============= Open Food Facts Router =============
  // Pantry intelligence (ethylene alerts, personal health alerts), rescue recipes and the WhatsApp link.
  insights: insightsRouter,
  rescue: rescueRouter,
  whatsapp: whatsappRouter,
  qc: qcRouter,
  receipt: receiptRouter,
  household: householdRouter,

  openFoodFacts: router({
    getByBarcode: publicProcedure
      .input(z.object({ barcode: z.string().max(64) }))
      .query(async ({ input }) => {
        const barcode = input.barcode.trim();
        // Only malformed input is rejected here. Check digits are validated (and overridable) on the client
        // because real Open Food Facts data contains some codes with invalid check digits.
        if (!isWellFormedBarcode(barcode)) return null;
        try {
          return await fetchOffProduct(barcode);
        } catch (err) {
          console.error("[OpenFoodFacts] Barcode fetch error:", err);
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "Open Food Facts is unreachable right now. Please try again in a moment.",
          });
        }
      }),

    search: publicProcedure
      .input(z.object({ query: z.string().max(200), pageSize: z.number().int().min(1).max(50).default(12) }))
      .query(async ({ input }) => {
        const q = input.query.trim();
        if (!q) return [];
        try {
          return await searchOffProducts(q, input.pageSize);
        } catch (err) {
          console.error("[OpenFoodFacts] Search error:", err);
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "Open Food Facts search is unavailable right now. Please try again in a moment.",
          });
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
