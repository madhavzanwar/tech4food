// Public API of the pure engines (safe to import from server and client).
export {
  ETHYLENE_TABLE,
  analyzeEthyleneStorage,
  ethyleneProfile,
  canonicalProduceKey,
} from "./ethylene";
export type {
  EthyleneLevel,
  EthyleneSeverity,
  EthyleneAlertKind,
  EthyleneProfile,
  EthyleneItemInput,
  EthyleneAlert,
  StorageSpace,
} from "./ethylene";

export {
  HEALTH_DISCLAIMER,
  FSA_THRESHOLDS,
  evaluateHealthAlerts,
  findHardConflicts,
  describeDietaryConstraints,
  detectConditions,
  detectMedications,
} from "./healthRules";
export type {
  HealthAlert,
  HealthSeverity,
  HealthAppliesToKind,
  HealthInput,
  HealthIngredient,
  HealthNutriments,
  HealthMedicationInput,
} from "./healthRules";

export {
  MAX_RECIPE_MINUTES,
  INSPECTION_NOTE,
  RESCUE_SAFETY_NOTE,
  selectRescueItems,
  buildRescuePrompt,
  parseRescueRecipes,
  sanitizeRecipe,
  sanitizeRecipeDetailed,
  fallbackRescueRecipes,
  processRescueResponse,
  canonicalRescueItem,
} from "./rescue";
export type {
  RescueInputItem,
  RescueItem,
  RescueSelection,
  RescueOptions,
  RescueRecipe,
  ParsedRecipe,
  RescueContext,
  RescuePrompt,
  RescueResult,
  RescueDietType,
} from "./rescue";

export {
  SHELF_LIFE_TABLE,
  estimateShelfLife,
  classifyFoodItem,
  isFoodItem,
  addDaysIso,
  getShelfLifeEntry,
  listShelfLifeKeys,
  normalizeFoodName,
} from "./shelfLife";
export type {
  ShelfLifeLocation,
  ShelfLifeConfidence,
  ShelfLifeCategory,
  ShelfLifeDays,
  ShelfLifeEntry,
  ShelfLifeOptions,
  ShelfLifeEstimate,
} from "./shelfLife";

export {
  MAX_RECEIPT_ITEMS,
  RECEIPT_EXTRACTION_PROMPT,
  parseReceiptText,
  buildReceiptExtractionMessages,
  sanitizeReceiptItems,
  enrichReceiptItems,
  normalizeReceiptUnit,
  toSafeAscii,
} from "./receiptParser";
export type {
  ReceiptSkipReason,
  ReceiptUnit,
  ParsedReceiptItem,
  SkippedReceiptLine,
  ParsedReceipt,
  ParseReceiptOptions,
  ReceiptLineConfidence,
  ReceiptExtractionMessage,
  SanitizedReceiptItem,
  SanitizeReceiptResult,
} from "./receiptParser";

export {
  MAX_EBILL_CHARS,
  EBILL_MERCHANTS,
  ebillToText,
  htmlToText,
  decodeMimeWords,
  detectEbillMerchant,
} from "./ebill";
export type { EbillMerchantId, EbillMerchant, EbillFormat, EbillText } from "./ebill";

export {
  DEFAULT_QC_THRESHOLDS,
  DEFAULT_QC_ACCEPTANCE,
  gradePhoto,
  summarizeBatch,
  vendorScorecard,
  toCsv,
  csvCell,
  batchReportCsv,
  batchPhotosCsv,
  vendorScorecardCsv,
} from "./qcGrading";
export type {
  QcGrade,
  QcVerdict,
  QcPhotoInput,
  QcThresholds,
  QcAcceptance,
  QcPhotoGrade,
  QcCounts,
  QcBatchSummary,
  SummarizeBatchOptions,
  QcTrend,
  VendorScore,
  VendorScorecard,
} from "./qcGrading";

export {
  cleanItemQuery,
  buildBlinkitUrl,
  buildZeptoUrl,
  buildInstacartUrl,
  buildAmazonFreshUrl,
  buildWhatsAppShoppingListUrl,
  buildItemReorderLinks,
  buildBatchReorderLinks,
} from "./reorder";
export type {
  QuickCommerceProvider,
  ReorderItem,
  ReorderLink,
} from "./reorder";
