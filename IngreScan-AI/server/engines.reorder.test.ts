import { describe, expect, it } from "vitest";
import {
  cleanItemQuery,
  buildBlinkitUrl,
  buildZeptoUrl,
  buildInstacartUrl,
  buildAmazonFreshUrl,
  buildWhatsAppShoppingListUrl,
  buildItemReorderLinks,
  buildBatchReorderLinks,
} from "@shared/engines";

describe("reorder engine (Pantry-to-Cart quick commerce)", () => {
  it("cleans noisy item names for commercial search", () => {
    expect(cleanItemQuery("Fresh Organic Red Apples (500g)")).toBe("Red Apples");
    expect(cleanItemQuery("Raw Milk 1L packet")).toBe("Milk");
    expect(cleanItemQuery("Canned Diced Tomatoes")).toBe("Tomatoes");
  });

  it("builds correct Blinkit quick commerce search URL", () => {
    const url = buildBlinkitUrl("Organic Whole Milk 1L");
    expect(url).toContain("https://blinkit.com/s/?q=Whole%20Milk");
  });

  it("builds correct Zepto quick commerce search URL", () => {
    const url = buildZeptoUrl("Fresh Brown Eggs 6 pcs");
    expect(url).toContain("https://www.zeptonow.com/search?query=Brown%20Eggs");
  });

  it("builds Instacart search URL", () => {
    const url = buildInstacartUrl("Avocados");
    expect(url).toContain("https://www.instacart.com/store/s?k=Avocados");
  });

  it("builds Amazon Fresh URLs for India and International", () => {
    const urlIn = buildAmazonFreshUrl("Olive Oil", "in");
    expect(urlIn).toContain("https://www.amazon.in/s?k=Olive%20Oil&i=nowstore");

    const urlUs = buildAmazonFreshUrl("Olive Oil", "us");
    expect(urlUs).toContain("https://www.amazon.com/s?k=Olive%20Oil&i=amazonfresh");
  });

  it("creates formatted WhatsApp shopping checklist export", () => {
    const url = buildWhatsAppShoppingListUrl(["Tomatoes", { name: "Milk", quantity: "2 packets" }]);
    expect(url).toContain("https://wa.me/?text=");
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("FoodIQ Shopping Checklist");
    expect(decoded).toContain("1. [ ] Tomatoes");
    expect(decoded).toContain("2. [ ] Milk (2 packets)");
  });

  it("returns individual reorder options for a single item", () => {
    const links = buildItemReorderLinks("Ripe Bananas");
    expect(links.length).toBe(4);
    expect(links.map((l) => l.provider)).toEqual(["blinkit", "zepto", "instacart", "amazon_fresh"]);
    expect(links[0].url).toContain("blinkit.com");
    expect(links[1].url).toContain("zeptonow.com");
  });

  it("returns batch reorder links for multiple missing ingredients", () => {
    const batch = buildBatchReorderLinks(["Garlic", "Olive Oil", "Parmesan"]);
    expect(batch.length).toBe(3);
    expect(batch.some((b) => b.provider === "blinkit")).toBe(true);
    expect(batch.some((b) => b.provider === "zepto")).toBe(true);
    expect(batch.some((b) => b.provider === "whatsapp")).toBe(true);
  });
});
