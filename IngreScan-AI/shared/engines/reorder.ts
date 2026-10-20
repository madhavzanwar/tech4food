/**
 * Quick-Commerce Pantry-to-Cart deep link generator.
 * Supports direct product search & cart creation for quick-commerce and grocery platforms:
 * - Blinkit (India)
 * - Zepto (India)
 * - Instacart (US/Canada/International)
 * - Amazon Fresh (Universal)
 * - WhatsApp Shopping List Share
 */

export type QuickCommerceProvider = "blinkit" | "zepto" | "instacart" | "amazon_fresh" | "whatsapp";

export interface ReorderItem {
  name: string;
  quantity?: number | string;
  category?: string | null;
}

export interface ReorderLink {
  provider: QuickCommerceProvider;
  label: string;
  url: string;
  iconName: string;
  badge?: string;
}

/** Sanitize an item name for search queries (strip punctuation, weight markers, packaging words) */
export function cleanItemQuery(item: string): string {
  return item
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d+(\.\d+)?\s*(g|kg|ml|l|oz|lb|pcs|pack|packet|bunch)\b/gi, " ")
    .replace(/\b(organic|fresh|raw|cooked|frozen|canned|diced|sliced|chopped|packet|bunch|piece|pcs)\b/gi, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generate a direct web search/cart URL for Blinkit.
 * Blinkit query URL: https://blinkit.com/s/?q={query}
 */
export function buildBlinkitUrl(query: string): string {
  const q = encodeURIComponent(cleanItemQuery(query) || query);
  return `https://blinkit.com/s/?q=${q}`;
}

/**
 * Generate a direct search/cart URL for Zepto.
 * Zepto query URL: https://www.zeptonow.com/search?query={query}
 */
export function buildZeptoUrl(query: string): string {
  const q = encodeURIComponent(cleanItemQuery(query) || query);
  return `https://www.zeptonow.com/search?query=${q}`;
}

/**
 * Generate a direct search/cart URL for Instacart.
 * Instacart query URL: https://www.instacart.com/store/s?k={query}
 */
export function buildInstacartUrl(query: string): string {
  const q = encodeURIComponent(cleanItemQuery(query) || query);
  return `https://www.instacart.com/store/s?k=${q}`;
}

/**
 * Generate an Amazon Fresh search URL.
 * URL: https://www.amazon.com/s?k={query}&i=amazonfresh (or national amazon domain)
 */
export function buildAmazonFreshUrl(query: string, domain: string = "in"): string {
  const q = encodeURIComponent(cleanItemQuery(query) || query);
  if (domain === "in") {
    return `https://www.amazon.in/s?k=${q}&i=nowstore`;
  }
  return `https://www.amazon.com/s?k=${q}&i=amazonfresh`;
}

/**
 * Generate a pre-formatted WhatsApp share link with a shopping checklist.
 */
export function buildWhatsAppShoppingListUrl(items: Array<string | ReorderItem>): string {
  const itemLines = items.map((it, idx) => {
    const name = typeof it === "string" ? it : it.name;
    const qty = typeof it === "object" && it.quantity ? ` (${it.quantity})` : "";
    return `${idx + 1}. [ ] ${name}${qty}`;
  });

  const message = [
    "*🛒 FoodIQ Shopping Checklist*",
    "Items to restock / recipe ingredients:",
    "",
    ...itemLines,
    "",
    "Sent via FoodIQ Smart Pantry",
  ].join("\n");

  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

/**
 * Build all supported deep links for a single item (e.g. an expiring or consumed item).
 */
export function buildItemReorderLinks(item: string | ReorderItem): ReorderLink[] {
  const name = typeof item === "string" ? item : item.name;
  return [
    {
      provider: "blinkit",
      label: "Blinkit",
      url: buildBlinkitUrl(name),
      iconName: "Zap",
      badge: "10 mins",
    },
    {
      provider: "zepto",
      label: "Zepto",
      url: buildZeptoUrl(name),
      iconName: "ShoppingBag",
      badge: "10 mins",
    },
    {
      provider: "instacart",
      label: "Instacart",
      url: buildInstacartUrl(name),
      iconName: "Store",
      badge: "Same day",
    },
    {
      provider: "amazon_fresh",
      label: "Amazon Fresh",
      url: buildAmazonFreshUrl(name, "in"),
      iconName: "Truck",
      badge: "Scheduled",
    },
  ];
}

/**
 * Build aggregated multi-item quick commerce and shopping list links
 * (e.g., for missing recipe staples or multiple expiring pantry items).
 */
export function buildBatchReorderLinks(items: Array<string | ReorderItem>): ReorderLink[] {
  if (items.length === 0) return [];
  const primaryName = typeof items[0] === "string" ? items[0] : items[0].name;

  return [
    {
      provider: "blinkit",
      label: `Order on Blinkit (${cleanItemQuery(primaryName)})`,
      url: buildBlinkitUrl(primaryName),
      iconName: "Zap",
      badge: "10 mins",
    },
    {
      provider: "zepto",
      label: `Order on Zepto (${cleanItemQuery(primaryName)})`,
      url: buildZeptoUrl(primaryName),
      iconName: "ShoppingBag",
      badge: "10 mins",
    },
    {
      provider: "whatsapp",
      label: `Export ${items.length} items to WhatsApp List`,
      url: buildWhatsAppShoppingListUrl(items),
      iconName: "MessageCircle",
      badge: "Shopping List",
    },
  ];
}
