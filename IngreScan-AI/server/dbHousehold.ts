import { eq } from "drizzle-orm";
import { getDbContext, insertedId } from "./_core/database";

export function generateInviteCode(): string {
  // 6 chars uppercase, avoiding confusing chars like 0, O, 1, I
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Returns all user IDs belonging to the same household as the given user (including userId).
 * If the user does not belong to any household, returns [userId].
 */
export async function getHouseholdMemberUserIds(userId: number): Promise<number[]> {
  const ctx = await getDbContext();
  if (!ctx) return [userId];
  const { db, s } = ctx;

  const membership = await db
    .select({ householdId: s.householdMembers.householdId })
    .from(s.householdMembers)
    .where(eq(s.householdMembers.userId, userId))
    .limit(1);

  if (!membership[0]) return [userId];

  const members = await db
    .select({ userId: s.householdMembers.userId })
    .from(s.householdMembers)
    .where(eq(s.householdMembers.householdId, membership[0].householdId));

  const ids = members.map((m) => m.userId);
  return ids.length > 0 ? ids : [userId];
}

/**
 * Create a new household and assign the user as owner.
 */
export async function createHousehold(name: string, ownerId: number) {
  const ctx = await getDbContext();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;

  // Leave any current household before creating a new one
  await leaveHousehold(ownerId);

  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    const inviteCode = generateInviteCode();
    try {
      const res = await db.insert(s.households).values({
        name: name.trim(),
        inviteCode,
        ownerId,
      });
      const householdId = insertedId(ctx, res);

      await db.insert(s.householdMembers).values({
        householdId,
        userId: ownerId,
        role: "owner",
      });

      return {
        id: householdId,
        name: name.trim(),
        inviteCode,
        ownerId,
      };
    } catch (err) {
      if (attempts >= 5) throw err;
    }
  }
  throw new Error("Failed to generate unique invite code");
}

/**
 * Get household details and member list for a given user.
 */
export async function getHouseholdByUser(userId: number) {
  const ctx = await getDbContext();
  if (!ctx) return null;
  const { db, s } = ctx;

  const membership = await db
    .select()
    .from(s.householdMembers)
    .where(eq(s.householdMembers.userId, userId))
    .limit(1);

  if (!membership[0]) return null;

  const householdRows = await db
    .select()
    .from(s.households)
    .where(eq(s.households.id, membership[0].householdId))
    .limit(1);

  if (!householdRows[0]) return null;
  const household = householdRows[0];

  const members = await db
    .select({
      id: s.householdMembers.id,
      userId: s.householdMembers.userId,
      role: s.householdMembers.role,
      joinedAt: s.householdMembers.joinedAt,
      name: s.users.name,
      email: s.users.email,
    })
    .from(s.householdMembers)
    .leftJoin(s.users, eq(s.householdMembers.userId, s.users.id))
    .where(eq(s.householdMembers.householdId, household.id));

  return {
    household,
    isOwner: household.ownerId === userId,
    myRole: membership[0].role,
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      name: m.name || (m.userId === userId ? "You" : `Member #${m.userId}`),
      email: m.email ?? null,
    })),
  };
}

/**
 * Join an existing household using a 6-character invite code.
 */
export async function joinHouseholdByCode(userId: number, code: string) {
  const ctx = await getDbContext();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;

  const cleanCode = code.trim().toUpperCase();
  const householdRows = await db
    .select()
    .from(s.households)
    .where(eq(s.households.inviteCode, cleanCode))
    .limit(1);

  if (!householdRows[0]) {
    throw new Error("Invalid invite code. No household found.");
  }
  const household = householdRows[0];

  // Check if user is already in a household
  const existing = await db
    .select()
    .from(s.householdMembers)
    .where(eq(s.householdMembers.userId, userId))
    .limit(1);

  if (existing[0]) {
    if (existing[0].householdId === household.id) {
      return household; // Already a member of this household
    }
    // Leave previous household
    await leaveHousehold(userId);
  }

  await db.insert(s.householdMembers).values({
    householdId: household.id,
    userId,
    role: "member",
  });

  return household;
}

/**
 * Leave current household. If the leaving user is the owner,
 * ownership is transferred to the next member; if no members remain,
 * the household is deleted.
 */
export async function leaveHousehold(userId: number): Promise<boolean> {
  const ctx = await getDbContext();
  if (!ctx) return false;
  const { db, s } = ctx;

  const membership = await db
    .select()
    .from(s.householdMembers)
    .where(eq(s.householdMembers.userId, userId))
    .limit(1);

  if (!membership[0]) return false;
  const householdId = membership[0].householdId;

  // Remove membership
  await db.delete(s.householdMembers).where(eq(s.householdMembers.userId, userId));

  // Check remaining members
  const remaining = await db
    .select()
    .from(s.householdMembers)
    .where(eq(s.householdMembers.householdId, householdId))
    .orderBy(s.householdMembers.joinedAt);

  if (remaining.length === 0) {
    // Delete household
    await db.delete(s.households).where(eq(s.households.id, householdId));
  } else if (membership[0].role === "owner") {
    // Reassign owner to the next member
    const nextOwner = remaining[0];
    await db.update(s.households).set({ ownerId: nextOwner.userId }).where(eq(s.households.id, householdId));
    await db.update(s.householdMembers).set({ role: "owner" }).where(eq(s.householdMembers.id, nextOwner.id));
  }

  return true;
}

/**
 * Update household name (owner only).
 */
export async function updateHouseholdName(userId: number, name: string) {
  const ctx = await getDbContext();
  if (!ctx) throw new Error("Database not available");
  const { db, s } = ctx;

  const info = await getHouseholdByUser(userId);
  if (!info || !info.isOwner) {
    throw new Error("Only the household owner can rename the fridge");
  }

  await db.update(s.households).set({ name: name.trim() }).where(eq(s.households.id, info.household.id));
  return { ...info.household, name: name.trim() };
}
