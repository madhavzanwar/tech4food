/**
 * Routers for B2B incoming-produce quality control (batch grading, vendor scorecards, CSV export)
 * and grocery receipt import. Merged into appRouter in routers.ts.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  batchPhotosCsv,
  batchReportCsv,
  buildReceiptExtractionMessages,
  ebillToText,
  enrichReceiptItems,
  gradePhoto,
  parseReceiptText,
  sanitizeReceiptItems,
  summarizeBatch,
  vendorScorecard,
  vendorScorecardCsv,
} from "@shared/engines";
import { protectedProcedure, router } from "./_core/trpc";
import { invokeLLM, isRealLLMConfigured } from "./_core/llm";
import * as db from "./db";
import * as dbf from "./dbFeatures";
import { getLLMText, isValidYmd, parseTimestampInput, computeExpiry } from "./logic";

const FRESHNESS = z.enum(["fresh", "normal", "rotten"]);

function parseReasons(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type StoredItem = { label: string | null; fruitType: string; freshness: string; pFresh: number; confidence: number };
type StoredBatch = { vendor: string; lotId: string | null; createdAt: Date; declaredSampleSize?: number | null };

/** Rebuild the auditable summary from stored photos, so the grading rule can never drift from the numbers. */
function summaryFor(batch: StoredBatch, items: StoredItem[]) {
  return summarizeBatch(
    items.map((i) => ({ freshness_status: i.freshness, p_fresh: i.pFresh, confidence: i.confidence, fruit: i.fruitType, photoId: i.label ?? undefined })),
    { vendor: batch.vendor, lotId: batch.lotId ?? undefined, sampleSize: batch.declaredSampleSize ?? undefined, receivedAt: batch.createdAt.toISOString() }
  );
}

export const qcRouter = router({
  /**
   * Grades a batch of crate photos (each already classified by the FreshGuard model) and stores it.
   * Grades are always computed here from the model outputs; client-supplied grades are never trusted.
   */
  gradeBatch: protectedProcedure
    .input(
      z.object({
        vendor: z.string().trim().min(1).max(120),
        lotId: z.string().trim().max(80).optional(),
        notes: z.string().max(2000).optional(),
        sampleSize: z.number().int().min(1).max(100000).optional(),
        items: z
          .array(
            z.object({
              label: z.string().trim().max(160).optional(),
              fruit: z.string().trim().min(1).max(64),
              freshness: FRESHNESS,
              pFresh: z.number().min(0).max(100),
              confidence: z.number().min(0).max(100),
            })
          )
          .min(1)
          .max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const photoInputs = input.items.map((i, idx) => ({
        freshness_status: i.freshness,
        p_fresh: i.pFresh,
        confidence: i.confidence,
        fruit: i.fruit,
        photoId: i.label ?? `photo-${idx + 1}`,
      }));
      const summary = summarizeBatch(photoInputs, {
        vendor: input.vendor,
        lotId: input.lotId,
        sampleSize: input.sampleSize,
        receivedAt: new Date().toISOString(),
      });
      const grades = input.items.map((_, idx) => gradePhoto(photoInputs[idx]));
      const id = await dbf.createQcBatch(
        {
          userId: ctx.user.id,
          vendor: input.vendor,
          lotId: input.lotId ?? null,
          notes: input.notes ?? null,
          declaredSampleSize: input.sampleSize ?? null,
          verdict: summary.verdict,
          total: input.items.length,
          gradeA: summary.counts.A,
          gradeB: summary.counts.B,
          gradeReview: summary.counts.REVIEW,
          gradeReject: summary.counts.REJECT,
          meanPFresh: summary.pFresh?.mean ?? 0,
        },
        input.items.map((i, idx) => ({
          label: i.label ?? null,
          fruitType: i.fruit,
          freshness: i.freshness,
          pFresh: i.pFresh,
          confidence: i.confidence,
          grade: grades[idx].grade,
          reasons: JSON.stringify(grades[idx].reasons),
        }))
      );
      return { id, summary };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const batches = await dbf.listQcBatches(ctx.user.id, 100);
    return batches.map((b) => ({
      id: b.id,
      vendor: b.vendor,
      lotId: b.lotId,
      verdict: b.verdict,
      total: b.total,
      counts: { A: b.gradeA, B: b.gradeB, REVIEW: b.gradeReview, REJECT: b.gradeReject },
      meanPFresh: b.meanPFresh,
      createdAt: b.createdAt.toISOString(),
    }));
  }),

  get: protectedProcedure.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
    const found = await dbf.getQcBatchWithItems(ctx.user.id, input.id);
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Batch not found" });
    return {
      batch: { ...found.batch, createdAt: found.batch.createdAt.toISOString() },
      items: found.items.map((i) => ({ id: i.id, label: i.label, fruit: i.fruitType, freshness: i.freshness, pFresh: i.pFresh, confidence: i.confidence, grade: i.grade, reasons: parseReasons(i.reasons) })),
      summary: summaryFor(found.batch, found.items),
    };
  }),

  delete: protectedProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    if (!(await dbf.deleteQcBatch(ctx.user.id, input.id))) throw new TRPCError({ code: "NOT_FOUND", message: "Batch not found" });
    return { success: true };
  }),

  /** Vendor ranking and trends across the user's stored batches. */
  scorecard: protectedProcedure.query(async ({ ctx }) => {
    const batches = await dbf.listQcBatches(ctx.user.id, 100);
    return vendorScorecard(
      batches.map((b) => ({
        vendor: b.vendor,
        receivedAt: b.createdAt.toISOString(),
        verdict: b.verdict,
        counts: { A: b.gradeA, B: b.gradeB, REVIEW: b.gradeReview, REJECT: b.gradeReject },
      }))
    );
  }),

  /**
   * CSV text (formula-injection safe): a batch summary, one row per photo (kind "photos", for audits), or,
   * without an id, the vendor scorecard.
   */
  csv: protectedProcedure.input(z.object({ id: z.number().int().optional(), kind: z.enum(["summary", "photos"]).default("summary") })).query(async ({ ctx, input }) => {
    if (input.id !== undefined) {
      const found = await dbf.getQcBatchWithItems(ctx.user.id, input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Batch not found" });
      const summary = summaryFor(found.batch, found.items);
      return input.kind === "photos"
        ? { filename: `qc-batch-${input.id}-photos.csv`, csv: batchPhotosCsv(summary) }
        : { filename: `qc-batch-${input.id}.csv`, csv: batchReportCsv(summary) };
    }
    const batches = await dbf.listQcBatches(ctx.user.id, 100);
    const card = vendorScorecard(
      batches.map((b) => ({
        vendor: b.vendor,
        receivedAt: b.createdAt.toISOString(),
        verdict: b.verdict,
        counts: { A: b.gradeA, B: b.gradeB, REVIEW: b.gradeReview, REJECT: b.gradeReject },
      }))
    );
    return { filename: "qc-vendor-scorecard.csv", csv: vendorScorecardCsv(card) };
  }),
});

// ------------------------------------------------------------------- Receipts

const MAX_IMAGE_DATA_URL = 12_000_000;

export const receiptRouter = router({
  /**
   * Turns pasted receipt / e-bill text (or a photo of a receipt) into pantry suggestions with estimated expiry
   * dates. Nothing is saved here: the user reviews and edits the list, then calls importItems.
   */
  parse: protectedProcedure
    .input(
      z
        .object({
          text: z.string().max(60_000).optional(),
          /** Raw content of an uploaded .eml / .html / .htm / .txt e-bill (read as text by the client). PDF is not supported. */
          ebill: z.object({ content: z.string().max(1_100_000), filename: z.string().max(255).optional() }).optional(),
          imageDataUrl: z.string().max(MAX_IMAGE_DATA_URL).regex(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i).optional(),
        })
        .refine((v) => Boolean(v.text?.trim()) || Boolean(v.ebill?.content?.trim()) || Boolean(v.imageDataUrl), {
          message: "Provide receipt text, an e-bill file or a receipt photo.",
        })
    )
    .mutation(async ({ input }) => {
      const now = new Date();
      const rawText = input.ebill?.content?.trim() ? input.ebill.content : input.text?.trim() ? input.text : "";
      if (rawText) {
        // An uploaded file is always an e-bill. Pasted text is treated as one when it is an email/HTML or a known merchant.
        const eb = ebillToText(rawText, { filename: input.ebill?.filename });
        const uploaded = Boolean(input.ebill?.content?.trim());
        if (uploaded && !eb.text.trim()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: eb.warnings[eb.warnings.length - 1] ?? "That e-bill had no readable text. Paste the bill text instead." });
        }
        const isEbill = uploaded || eb.format !== "text" || eb.merchant.id !== "generic";
        const body = isEbill ? eb.text : rawText;
        const parsed = parseReceiptText(body, {
          now,
          ...(isEbill ? { ebill: true, merchant: eb.merchant.id, fallbackDate: eb.headerDate } : {}),
        });
        const meta = {
          merchant: isEbill && eb.merchant.id !== "generic" ? eb.merchant.name : null,
          orderDate: parsed.purchaseDate ?? null,
          orderDateSource: parsed.purchaseDateSource ?? null,
          ebillFormat: isEbill ? eb.format : null,
          subject: eb.subject ?? null,
        };
        const warnings = isEbill ? [...eb.warnings, ...parsed.warnings] : parsed.warnings;
        if (parsed.items.length > 0 || !isRealLLMConfigured()) {
          return { source: "parser" as const, items: parsed.items, skipped: parsed.skipped, currency: parsed.currency ?? null, store: parsed.store ?? null, ...meta, warnings };
        }
        // Nothing recognised and a real model is available: let it read the layout.
        const viaLlm = await extractWithLLM(body, now);
        return { ...viaLlm, ...meta, warnings: [...warnings, ...viaLlm.warnings] };
      }
      if (!isRealLLMConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Reading a receipt photo needs an AI key on the server. Paste the receipt text instead.",
        });
      }
      return extractWithLLM(input.imageDataUrl!, now);
    }),

  /** Saves the reviewed items to the pantry (the packaged-food fridge tracker). */
  importItems: protectedProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(255),
              quantity: z.number().min(0).max(100000).default(1),
              unit: z.string().max(16).default("pcs"),
              category: z.string().max(100).default("Other"),
              storageLocation: z.enum(["fridge", "freezer", "pantry"]).default("fridge"),
              expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expiry must be YYYY-MM-DD"),
            })
          )
          .min(1)
          .max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Validate everything first so a bad row cannot leave a half-imported receipt behind.
      const prepared = input.items.map((item) => {
        const expiry = isValidYmd(item.expiryDate) ? parseTimestampInput(`${item.expiryDate}T00:00:00Z`) : null;
        if (!expiry) throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid expiry date for "${item.name}"` });
        return { item, expiry };
      });
      const now = new Date();
      for (const { item, expiry } of prepared) {
        const { status } = computeExpiry(expiry, now);
        await db.addInventoryItem({
          userId: ctx.user.id,
          title: item.name,
          category: item.category,
          quantity: `${item.quantity} ${item.unit}`.trim().slice(0, 100),
          storageLocation: item.storageLocation,
          expiryDate: expiry,
          notes: "Imported from receipt",
          status,
        });
      }
      return { imported: prepared.length };
    }),
});

async function extractWithLLM(textOrImage: string, now: Date) {
  let reply = "";
  try {
    reply = getLLMText(await invokeLLM({ messages: buildReceiptExtractionMessages(textOrImage) as any }));
  } catch (err) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: err instanceof Error ? err.message : "AI service unavailable" });
  }
  const sanitized = sanitizeReceiptItems(reply);
  return {
    source: "llm" as const,
    items: enrichReceiptItems(sanitized.items, { now }),
    skipped: [] as Array<{ line: string; reason: string }>,
    currency: null as string | null,
    store: null as string | null,
    merchant: null as string | null,
    orderDate: null as string | null,
    orderDateSource: null as "bill" | "email" | null,
    ebillFormat: null as "eml" | "html" | "text" | null,
    subject: null as string | null,
    warnings: sanitized.warnings,
  };
}
