/**
 * Router for multi-member household fridge sharing.
 * Enables in-app family/roommate pantry sharing via 6-character invite codes.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import {
  createHousehold,
  getHouseholdByUser,
  joinHouseholdByCode,
  leaveHousehold,
  updateHouseholdName,
} from "./dbHousehold";

export const householdRouter = router({
  /**
   * Get current household status, members, and invite code for the authenticated user.
   */
  get: protectedProcedure.query(async ({ ctx }) => {
    return await getHouseholdByUser(ctx.user.id);
  }),

  /**
   * Create a new household with a given name (e.g. "Family Fridge").
   */
  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(2, "Name must be at least 2 characters").max(100) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const household = await createHousehold(input.name, ctx.user.id);
        return { success: true, household };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err?.message || "Failed to create household",
        });
      }
    }),

  /**
   * Join an existing household using an invite code.
   */
  join: protectedProcedure
    .input(z.object({ inviteCode: z.string().trim().min(3).max(16) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const household = await joinHouseholdByCode(ctx.user.id, input.inviteCode);
        return { success: true, household };
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err?.message || "Invalid invite code",
        });
      }
    }),

  /**
   * Leave the current household.
   */
  leave: protectedProcedure.mutation(async ({ ctx }) => {
    const left = await leaveHousehold(ctx.user.id);
    return { success: left };
  }),

  /**
   * Rename the household (owner only).
   */
  updateName: protectedProcedure
    .input(z.object({ name: z.string().trim().min(2).max(100) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const updated = await updateHouseholdName(ctx.user.id, input.name);
        return { success: true, household: updated };
      } catch (err: any) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: err?.message || "Failed to update household",
        });
      }
    }),
});
