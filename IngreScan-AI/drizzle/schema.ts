import { index, uniqueIndex, int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, float } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * User profile with personal and health details
 */
export const userProfiles = mysqlTable("user_profiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  age: int("age"),
  gender: mysqlEnum("gender", ["male", "female", "other"]),
  height: int("height"), // in cm
  weight: int("weight"), // in kg
  bmi: float("bmi"),
  exerciseFrequency: mysqlEnum("exercise_frequency", ["sedentary", "light", "moderate", "active", "very_active"]),
  dietType: mysqlEnum("diet_type", ["veg", "non_veg", "vegan", "keto", "other"]),
  region: varchar("region", { length: 64 }), // country/city used to suggest locally available brands
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, t => ({
  userIdUnique: uniqueIndex("user_profiles_user_id_unique").on(t.userId),
}));

export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;

/**
 * Medical conditions for users
 */
export const medicalConditions = mysqlTable("medical_conditions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  condition: text("condition").notNull(),
  diagnosedDate: timestamp("diagnosed_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userIdIdx: index("medical_conditions_user_id_idx").on(t.userId),
}));

export type MedicalCondition = typeof medicalConditions.$inferSelect;
export type InsertMedicalCondition = typeof medicalConditions.$inferInsert;

/**
 * Medications (current and past)
 */
export const medications = mysqlTable("medications", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  dosage: varchar("dosage", { length: 100 }),
  frequency: varchar("frequency", { length: 100 }),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  isCurrent: boolean("is_current").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, t => ({
  userIdIdx: index("medications_user_id_idx").on(t.userId),
}));

export type Medication = typeof medications.$inferSelect;
export type InsertMedication = typeof medications.$inferInsert;

/**
 * Food scans performed by users
 */
export const foodScans = mysqlTable("food_scans", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  productName: varchar("product_name", { length: 255 }),
  inputType: mysqlEnum("input_type", ["text", "image"]).notNull(),
  imageUrl: text("image_url"),
  imageKey: text("image_key"),
  rawIngredients: text("raw_ingredients"),
  ocrText: text("ocr_text"),
  riskScore: int("risk_score"), // 0-100
  analysisComplete: boolean("analysis_complete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, t => ({
  userIdIdx: index("food_scans_user_id_idx").on(t.userId),
}));

export type FoodScan = typeof foodScans.$inferSelect;
export type InsertFoodScan = typeof foodScans.$inferInsert;

/**
 * Individual ingredients detected in scans
 */
export const scanIngredients = mysqlTable("scan_ingredients", {
  id: int("id").autoincrement().primaryKey(),
  scanId: int("scan_id").notNull().references(() => foodScans.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  scientificName: varchar("scientific_name", { length: 255 }),
  category: varchar("category", { length: 100 }),
  riskLevel: mysqlEnum("risk_level", ["safe", "low", "moderate", "high", "severe"]),
  shortTermEffects: text("short_term_effects"),
  longTermEffects: text("long_term_effects"),
  sideEffects: text("side_effects"),
  personalizedRisk: text("personalized_risk"),
  sources: text("sources"), // JSON array of source URLs
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  scanIdIdx: index("scan_ingredients_scan_id_idx").on(t.scanId),
}));

export type ScanIngredient = typeof scanIngredients.$inferSelect;
export type InsertScanIngredient = typeof scanIngredients.$inferInsert;

/**
 * Alternative product suggestions
 */
export const alternatives = mysqlTable("alternatives", {
  id: int("id").autoincrement().primaryKey(),
  scanId: int("scan_id").notNull().references(() => foodScans.id, { onDelete: "cascade" }),
  productName: varchar("product_name", { length: 255 }).notNull(),
  brand: varchar("brand", { length: 255 }), // specific commercial brand when the model can name one
  reason: text("reason").notNull(),
  scientificJustification: text("scientific_justification"),
  sources: text("sources"), // JSON array
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  scanIdIdx: index("alternatives_scan_id_idx").on(t.scanId),
}));

export type Alternative = typeof alternatives.$inferSelect;
export type InsertAlternative = typeof alternatives.$inferInsert;

/**
 * Chat messages between user and AI
 */
export const chatMessages = mysqlTable("chat_messages", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  scanId: int("scan_id").references(() => foodScans.id, { onDelete: "cascade" }), // optional, if chat is related to a specific scan
  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userIdIdx: index("chat_messages_user_id_idx").on(t.userId),
  scanIdIdx: index("chat_messages_scan_id_idx").on(t.scanId),
}));

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;

/**
 * Ingredient knowledge base (cached from external APIs)
 */
export const ingredientDatabase = mysqlTable("ingredient_database", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  scientificName: varchar("scientific_name", { length: 255 }),
  category: varchar("category", { length: 100 }),
  description: text("description"),
  healthImpact: text("health_impact"),
  regulatoryStatus: text("regulatory_status"),
  fssaiData: text("fssai_data"), // JSON
  whoData: text("who_data"), // JSON
  sources: text("sources"), // JSON array
  lastUpdated: timestamp("last_updated").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type IngredientData = typeof ingredientDatabase.$inferSelect;
export type InsertIngredientData = typeof ingredientDatabase.$inferInsert;

/**
 * Food Expiry Tracker inventory items (EcoFridge Integration)
 */
export const foodInventory = mysqlTable("food_inventory", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  quantity: varchar("quantity", { length: 100 }).default("1").notNull(),
  storageLocation: mysqlEnum("storage_location", ["fridge", "freezer", "pantry"]).default("fridge").notNull(),
  foodImageUrl: text("food_image_url"),
  barcode: varchar("barcode", { length: 64 }),
  expiryDate: timestamp("expiry_date").notNull(),
  addedDate: timestamp("added_date").defaultNow().notNull(),
  notes: text("notes"),
  status: mysqlEnum("status", ["fresh", "expiring_soon", "expired", "consumed"]).default("fresh").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, t => ({
  userIdIdx: index("food_inventory_user_id_idx").on(t.userId),
}));

export type FoodInventoryItem = typeof foodInventory.$inferSelect;
export type InsertFoodInventoryItem = typeof foodInventory.$inferInsert;

/**
 * FreshGuard (fresh produce AI) — per-user pantry and scan history.
 * The Flask service only classifies images; everything saved lives here, scoped by user.
 */
export const produceScans = mysqlTable("produce_scans", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  fruitType: varchar("fruit_type", { length: 64 }).notNull(),
  fruitName: varchar("fruit_name", { length: 100 }).notNull(),
  freshness: mysqlEnum("freshness", ["fresh", "normal", "rotten"]).notNull(),
  freshnessLabel: varchar("freshness_label", { length: 64 }).notNull(),
  pFresh: float("p_fresh").notNull(),
  confidence: float("confidence").notNull(),
  imageUrl: varchar("image_url", { length: 512 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userIdx: index("produce_scans_user_id_idx").on(t.userId, t.createdAt),
}));

export type ProduceScan = typeof produceScans.$inferSelect;
export type InsertProduceScan = typeof produceScans.$inferInsert;

export const produceInventory = mysqlTable("produce_inventory", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  fruitType: varchar("fruit_type", { length: 64 }).notNull(),
  freshness: mysqlEnum("freshness", ["fresh", "normal", "rotten"]).notNull(),
  pFresh: float("p_fresh").notNull(),
  confidence: float("confidence").notNull(),
  imageUrl: varchar("image_url", { length: 512 }),
  expiryDate: varchar("expiry_date", { length: 10 }).notNull(), // YYYY-MM-DD
  storageTip: text("storage_tip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userIdx: index("produce_inventory_user_id_idx").on(t.userId),
}));

export type ProduceInventoryItem = typeof produceInventory.$inferSelect;
export type InsertProduceInventoryItem = typeof produceInventory.$inferInsert;

/**
 * WhatsApp bot: account link (phone <-> user), one-time link codes, conversation state, webhook de-duplication.
 */
export const whatsappLinks = mysqlTable("whatsapp_links", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  phone: varchar("phone", { length: 20 }).notNull(), // E.164, e.g. +919876543210
  timezone: varchar("timezone", { length: 64 }).default("UTC").notNull(),
  reminderHour: int("reminder_hour").default(9).notNull(),
  remindersEnabled: boolean("reminders_enabled").default(true).notNull(),
  lastInboundAt: timestamp("last_inbound_at"),
  lastReminderLocalDate: varchar("last_reminder_local_date", { length: 10 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userUnique: uniqueIndex("whatsapp_links_user_id_unique").on(t.userId),
  phoneUnique: uniqueIndex("whatsapp_links_phone_unique").on(t.phone),
}));

export type WhatsappLink = typeof whatsappLinks.$inferSelect;
export type InsertWhatsappLink = typeof whatsappLinks.$inferInsert;

export const whatsappLinkCodes = mysqlTable("whatsapp_link_codes", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  salt: varchar("salt", { length: 32 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  attempts: int("attempts").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userIdx: index("whatsapp_link_codes_user_id_idx").on(t.userId),
}));

export type WhatsappLinkCode = typeof whatsappLinkCodes.$inferSelect;

export const whatsappState = mysqlTable("whatsapp_state", {
  id: int("id").autoincrement().primaryKey(),
  phone: varchar("phone", { length: 20 }).notNull(),
  state: text("state").notNull(), // JSON conversation state (pending ADD, CLEAR choice, ...)
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, t => ({
  phoneUnique: uniqueIndex("whatsapp_state_phone_unique").on(t.phone),
}));

export const whatsappSeen = mysqlTable("whatsapp_seen", {
  id: int("id").autoincrement().primaryKey(),
  provider: varchar("provider", { length: 16 }).notNull(),
  messageId: varchar("message_id", { length: 128 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  messageUnique: uniqueIndex("whatsapp_seen_provider_message_unique").on(t.provider, t.messageId),
}));

/**
 * B2B incoming-produce quality control: a batch of crate photos graded A / B / REVIEW / REJECT.
 */
export const qcBatches = mysqlTable("qc_batches", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  vendor: varchar("vendor", { length: 120 }).notNull(),
  lotId: varchar("lot_id", { length: 80 }),
  notes: text("notes"),
  declaredSampleSize: int("declared_sample_size"), // physical sample size declared by the receiver (informational)
  verdict: varchar("verdict", { length: 32 }).notNull(),
  total: int("total").notNull(),
  gradeA: int("grade_a").default(0).notNull(),
  gradeB: int("grade_b").default(0).notNull(),
  gradeReview: int("grade_review").default(0).notNull(),
  gradeReject: int("grade_reject").default(0).notNull(),
  meanPFresh: float("mean_p_fresh").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  userIdx: index("qc_batches_user_id_idx").on(t.userId, t.createdAt),
}));

export type QcBatch = typeof qcBatches.$inferSelect;
export type InsertQcBatch = typeof qcBatches.$inferInsert;

export const qcItems = mysqlTable("qc_items", {
  id: int("id").autoincrement().primaryKey(),
  batchId: int("batch_id").notNull().references(() => qcBatches.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 160 }), // original file name or crate id
  fruitType: varchar("fruit_type", { length: 64 }).notNull(),
  freshness: mysqlEnum("freshness", ["fresh", "normal", "rotten"]).notNull(),
  pFresh: float("p_fresh").notNull(),
  confidence: float("confidence").notNull(),
  grade: varchar("grade", { length: 8 }).notNull(),
  reasons: text("reasons"), // JSON array of short strings
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  batchIdx: index("qc_items_batch_id_idx").on(t.batchId),
}));

export type QcItem = typeof qcItems.$inferSelect;
export type InsertQcItem = typeof qcItems.$inferInsert;

/**
 * Multi-member household fridge sharing.
 */
export const households = mysqlTable("households", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  inviteCode: varchar("invite_code", { length: 16 }).notNull(),
  ownerId: int("owner_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => ({
  inviteCodeUnique: uniqueIndex("households_invite_code_unique").on(t.inviteCode),
  ownerIdx: index("households_owner_id_idx").on(t.ownerId),
}));

export type Household = typeof households.$inferSelect;
export type InsertHousehold = typeof households.$inferInsert;

export const householdMembers = mysqlTable("household_members", {
  id: int("id").autoincrement().primaryKey(),
  householdId: int("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  userId: int("user_id").notNull(),
  role: varchar("role", { length: 32 }).default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, t => ({
  userIdx: uniqueIndex("household_members_user_id_unique").on(t.userId),
  householdIdx: index("household_members_household_id_idx").on(t.householdId),
}));

export type HouseholdMember = typeof householdMembers.$inferSelect;
export type InsertHouseholdMember = typeof householdMembers.$inferInsert;
