import DashboardLayout from "@/components/DashboardLayout";
import { PageHeader } from "@/components/brand/PageHeader";
import { StatusTag } from "@/components/brand/StatusTag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { toLocalDateInput } from "@/lib/utils";
import {
  AlertCircle,
  ArrowRight,
  Barcode,
  Flame,
  Globe,
  Info,
  Leaf,
  Loader2,
  Package,
  Refrigerator,
  Search,
  ScanLine,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { BarcodeScanner, type ScannedBarcode } from "@/components/BarcodeScanner";
import { checkBarcode } from "@/lib/barcode";
import { useLocation } from "wouter";
import { toast } from "sonner";

const SAMPLE_BARCODES = [
  { code: "8901030895470", name: "Maggi 2-Minute Noodles", region: "India" },
  { code: "3017620422003", name: "Nutella Hazelnut Spread", region: "Global" },
  { code: "737628064502", name: "Thai Kitchen Rice Noodles", region: "Asia" },
  { code: "8901491101833", name: "Lay's Classic Salted Chips", region: "India" },
  { code: "5449000000996", name: "Coca-Cola Original", region: "Global" },
  { code: "8901262010047", name: "Amul Butter Pasteurized", region: "India" },
];

function formatProductTitle(brand?: string | null, productName?: string | null): string {
  const cleanBrand = brand && brand.toLowerCase() !== "generic" ? brand.trim() : "";
  const cleanName = productName?.trim() ?? "";
  return [cleanBrand, cleanName].filter(Boolean).join(" ");
}

export default function OpenFoodFactsExplorer() {
  const [, setLocation] = useLocation();
  const [barcodeInput, setBarcodeInput] = useState("8901030895470");
  const [activeBarcode, setActiveBarcode] = useState("8901030895470");
  const [searchQuery, setSearchQuery] = useState("");
  // Only the submitted query drives the API call (not every keystroke)
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [activeTab, setActiveTab] = useState("barcode");
  const [showScanner, setShowScanner] = useState(false);

  // tRPC query for single barcode
  const {
    data: product,
    isLoading: isProductLoading,
    isError: isProductError,
    error: productError,
    refetch: refetchProduct,
  } = trpc.openFoodFacts.getByBarcode.useQuery(
    { barcode: activeBarcode },
    { enabled: Boolean(activeBarcode), retry: false }
  );

  // tRPC query for product search
  const {
    data: searchResults = [],
    isLoading: isSearchLoading,
    isError: isSearchError,
    error: searchError,
    refetch: refetchSearch,
  } = trpc.openFoodFacts.search.useQuery(
    { query: submittedQuery },
    { enabled: Boolean(submittedQuery && activeTab === "search"), retry: false }
  );

  // tRPC mutations
  const createScanMutation = trpc.scanner.createScan.useMutation();
  const analyzeMutation = trpc.analysis.analyzeIngredients.useMutation();
  const addToInventoryMutation = trpc.inventory.add.useMutation();

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!barcodeInput.trim()) {
      toast.error("Please enter a barcode number");
      return;
    }
    if (!/^\d{4,20}$/.test(barcodeInput.trim())) {
      toast.error("Barcodes contain only digits (usually 8 or 13). Please check the number.");
      return;
    }
    const check = checkBarcode(barcodeInput);
    if (!check.ok && check.reason === "bad_checksum") {
      toast.warning("The check digit of this barcode does not match, so the number may be mistyped. Looking it up anyway.");
    }
    setActiveBarcode(barcodeInput.trim());
  };

  // Camera / photo scan: fill the input with the code that is looked up, then query it right away.
  const handleScanned = (b: ScannedBarcode) => {
    setBarcodeInput(b.lookupCode);
    setActiveBarcode(b.lookupCode);
    setShowScanner(false);
    if (!b.checksumValid) toast.warning("The check digit of this barcode does not match; results may not be what you expect.");
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      toast.error("Please enter a product name to search");
      return;
    }
    const q = searchQuery.trim();
    if (q === submittedQuery) {
      refetchSearch();
    } else {
      setSubmittedQuery(q);
    }
  };

  // 1-Click Bridge to IngreScan-AI
  // True from the first click until the report page opens, so no second click can create a duplicate scan.
  const [bridging, setBridging] = useState(false);

  const handleAnalyzeWithAI = async () => {
    if (!product || bridging) return;
    if (!product.ingredientsText) {
      toast.error("No ingredients text available for this product on Open Food Facts.");
      return;
    }

    const toastId = toast.loading("Launching IngreScan-AI ingredient analysis...");
    setBridging(true);
    try {
      const scanRes = await createScanMutation.mutateAsync({
        productName: formatProductTitle(product.brand, product.productName),
        inputType: "text",
        rawIngredients: product.ingredientsText,
        imageUrl: product.imageUrl || undefined,
      });

      await analyzeMutation.mutateAsync({
        scanId: scanRes.scanId,
        ingredients: product.ingredientsText,
      });

      toast.success("Analysis complete! Redirecting to health risk report...", { id: toastId });
      setLocation(`/scan/${scanRes.scanId}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to analyze ingredients", { id: toastId });
    } finally {
      setBridging(false);
    }
  };

  // 1-Click Bridge to Food Expiry Tracker (Fridge)
  const handleAddToFridge = async () => {
    if (!product) return;
    const toastId = toast.loading("Adding to your Food Expiry Tracker...");
    try {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 14); // 2 weeks default

      await addToInventoryMutation.mutateAsync({
        title: formatProductTitle(product.brand, product.productName),
        category: product.category || "Snacks",
        quantity: "1 pack",
        storageLocation: "pantry",
        foodImageUrl: product.imageUrl || undefined,
        barcode: product.barcode,
        expiryDate: toLocalDateInput(expiry),
        notes: `Imported via Open Food Facts (Nutri-Score: ${product.nutriscoreGrade || "N/A"})`,
      });

      toast.success("Added to Expiry Tracker! View it in Fridge Tracker.", { id: toastId });
    } catch (err: any) {
      toast.error(err.message || "Failed to add to tracker", { id: toastId });
    }
  };


  // Nutri-Score / Eco-Score grades and NOVA groups keep their familiar
  // green â†’ red order, mapped onto the brand palette (white letter on solid fill).
  const getNutriscoreColor = (grade: string | null) => {
    switch (grade) {
      case "A":
        return "bg-verdant-ink text-white";
      case "B":
        return "bg-sky-ink text-white";
      case "C":
        return "bg-amber-ink text-white";
      case "D":
        return "bg-ember-deep text-white";
      case "E":
        return "bg-alert-ink text-white";
      default:
        return "bg-muted-foreground text-white";
    }
  };

  const getNovaColor = (group: number | null) => {
    switch (group) {
      case 1:
        return "bg-verdant-ink text-white";
      case 2:
        return "bg-sky-ink text-white";
      case 3:
        return "bg-amber-ink text-white";
      case 4:
        return "bg-negative-ink text-white";
      default:
        return "bg-muted-foreground text-white";
    }
  };

  const scoreTileClass = "flex min-w-0 flex-col gap-4 rounded-3xl bg-fog p-5";
  const scoreTitleClass = "flex items-center justify-between gap-2 text-sm font-bold text-graphite";
  const gradeBadgeClass =
    "grid h-14 w-14 shrink-0 place-items-center rounded-full text-2xl font-extrabold leading-none";

  return (
    <DashboardLayout>
      <div className="space-y-8 md:space-y-10">
        <PageHeader
          eyebrow="Global food database"
          title="Open Food Facts Explorer"
          description="Global food database integration with 3M+ packaged products. Scan barcodes, check Nutri-Score, NOVA Ultra-Processing ratings, and analyze with IngreScan-AI."
          actions={
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setLocation("/fridge")}
            >
              <Refrigerator className="h-4 w-4" />
              Go to Fridge Tracker
            </Button>
          }
        />

        {/* Tab Selection */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-6">
          <TabsList className="grid w-full grid-cols-2 bg-white sm:max-w-md">
            <TabsTrigger value="barcode" className="px-2 data-[state=active]:bg-graphite data-[state=active]:text-white">
              <Barcode className="h-4 w-4" /> Barcode Lookup
            </TabsTrigger>
            <TabsTrigger value="search" className="px-2 data-[state=active]:bg-graphite data-[state=active]:text-white">
              <Search className="h-4 w-4" />
              <span className="sm:hidden">Product Search</span>
              <span className="hidden sm:inline">Global Product Search</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: Barcode Lookup */}
          <TabsContent value="barcode" className="space-y-6">
            <section className="space-y-6 rounded-3xl bg-white p-5 md:p-7">
              <div className="flex items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog">
                  <Barcode className="h-5 w-5 text-ember-orange" />
                </span>
                <div className="min-w-0 space-y-1">
                  <h2 className="text-lg font-bold text-graphite">Scan or Enter Barcode</h2>
                  <p className="text-sm text-muted-foreground">
                    Enter an EAN-13, UPC, or Indian GTIN barcode to fetch verified food data from Open Food Facts.
                  </p>
                </div>
              </div>

              <form onSubmit={handleBarcodeSubmit} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <div className="relative flex-1 sm:min-w-[14rem]">
                  <Barcode className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="e.g., 8901030895470"
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    className="pl-12 font-mono text-base"
                    aria-label="Barcode number"
                    inputMode="numeric"
                  />
                </div>
                <Button type="submit">
                  <Search className="h-4 w-4" /> Search Barcode
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowScanner((v) => !v)}
                  aria-expanded={showScanner}
                  data-testid="explorer-scan-toggle"
                >
                  {showScanner ? <X className="h-4 w-4" /> : <ScanLine className="h-4 w-4" />}
                  {showScanner ? "Close scanner" : "Scan with camera / from photo"}
                </Button>
              </form>

              {showScanner && (
                <div className="rounded-3xl bg-fog p-4 sm:p-5" data-testid="explorer-scanner">
                  <BarcodeScanner onDetected={handleScanned} hideManual idPrefix="explorer-barcode" />
                </div>
              )}

              {/* Sample Barcodes */}
              <div>
                <p className="text-sm font-bold text-graphite">Quick Demo Barcodes:</p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {SAMPLE_BARCODES.map((s) => (
                    <button
                      key={s.code}
                      type="button"
                      className={`flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                        activeBarcode === s.code ? "bg-fog ring-1 ring-graphite/15" : "bg-fog hover:bg-[#ebebeb]"
                      }`}
                      onClick={() => {
                        setBarcodeInput(s.code);
                        setActiveBarcode(s.code);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-graphite">{s.name}</span>
                        <span className="block font-mono text-xs text-muted-foreground">({s.code})</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-3xl bg-white px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                        <Globe className="h-3 w-3" />
                        {s.region}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Product Details Display */}
            {isProductLoading ? (
              <div role="status" className="flex flex-col items-center gap-3 rounded-3xl bg-white px-5 py-16 text-center text-muted-foreground">
                <Loader2 className="h-7 w-7 animate-spin text-ember-orange" aria-hidden="true" />
                <p className="text-sm">Querying Open Food Facts database for barcode {activeBarcode}...</p>
              </div>
            ) : isProductError ? (
              <div role="alert" className="flex flex-col items-center rounded-3xl bg-white px-5 py-14 text-center">
                <span className="grid h-14 w-14 place-items-center rounded-3xl bg-fog">
                  <AlertCircle className="h-7 w-7 text-signal-red-orange" />
                </span>
                <p className="mt-5 font-bold text-graphite">Couldn&rsquo;t reach Open Food Facts</p>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  {productError?.message ?? "Please check your connection and try again."}
                </p>
                <Button variant="outline" className="mt-6" onClick={() => refetchProduct()}>
                  Try again
                </Button>
              </div>
            ) : product ? (
              <article className="overflow-hidden rounded-3xl bg-white">
                <div className="border-b border-border p-5 md:p-7">
                  <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-center">
                    <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-center">
                      {product.imageUrl ? (
                        <img
                          src={product.imageUrl}
                          alt={product.productName}
                          className="h-24 w-24 shrink-0 rounded-2xl border border-border bg-white object-contain p-1 sm:h-28 sm:w-28"
                        />
                      ) : (
                        <div className="grid h-24 w-24 shrink-0 place-items-center rounded-2xl bg-fog sm:h-28 sm:w-28">
                          <Package className="h-10 w-10 text-ember-orange" />
                        </div>
                      )}
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusTag className="font-mono">Barcode: {product.barcode}</StatusTag>
                          {product.brand && product.brand.toLowerCase() !== "generic" && <StatusTag tone="brand">{product.brand}</StatusTag>}
                        </div>
                        <h2 className="fn-heading-sm break-words text-graphite">
                          {product.productName}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          Category: {product.category}
                        </p>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto lg:shrink-0">
                      <Button
                        onClick={handleAnalyzeWithAI}
                        disabled={bridging}
                      >
                        <Sparkles className="h-4 w-4" />
                        Analyze with IngreScan-AI
                      </Button>

                      <Button
                        variant="outline"
                        onClick={handleAddToFridge}
                        disabled={addToInventoryMutation.isPending}
                      >
                        <Refrigerator className="h-4 w-4" />
                        Add to Fridge Tracker
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="space-y-8 p-5 md:p-7">
                  {/* Scores Grid */}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">
                    {/* Nutri-Score */}
                    <div className={scoreTileClass}>
                      <p className={scoreTitleClass}>
                        Nutri-Score
                        <Info className="h-4 w-4 text-muted-foreground" />
                      </p>
                      {product.nutriscoreGrade ? (
                        <div className="flex items-center gap-4">
                          <span className={`${gradeBadgeClass} ${getNutriscoreColor(product.nutriscoreGrade)}`}>
                            {product.nutriscoreGrade}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Nutritional quality grade (A = Highest, E = Lowest)
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not calculated</span>
                      )}
                    </div>

                    {/* NOVA Group */}
                    <div className={scoreTileClass}>
                      <p className={scoreTitleClass}>
                        NOVA Classification
                        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                      </p>
                      {product.novaGroup ? (
                        <div className="flex items-center gap-4">
                          <span className={`${gradeBadgeClass} ${getNovaColor(product.novaGroup)}`}>
                            {product.novaGroup}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {product.novaGroup === 4
                              ? "Ultra-Processed Food (High UPF)"
                              : product.novaGroup === 3
                              ? "Processed Food"
                              : product.novaGroup === 2
                              ? "Culinary Ingredient"
                              : "Unprocessed / Whole Food"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not classified</span>
                      )}
                    </div>

                    {/* Eco-Score */}
                    <div className={scoreTileClass}>
                      <p className={scoreTitleClass}>
                        Eco-Score
                        <Leaf className="h-4 w-4 text-verdant-green" />
                      </p>
                      {product.ecoscoreGrade ? (
                        <div className="flex items-center gap-4">
                          <span className={`${gradeBadgeClass} ${getNutriscoreColor(product.ecoscoreGrade)}`}>
                            {product.ecoscoreGrade}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Environmental impact score
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Eco-Score N/A</span>
                      )}
                    </div>
                  </div>

                  {/* Nutrition per 100g */}
                  <section className="space-y-4">
                    <h3 className="flex items-center gap-2 text-base font-bold text-graphite">
                      <Flame className="h-4 w-4 text-sunset-orange" />
                      Nutrition Facts (per 100g / 100ml)
                    </h3>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                      {[
                        {
                          label: "Energy",
                          value: product.nutriments.energyKcal != null ? `${product.nutriments.energyKcal} kcal` : "—",
                          dot: null,
                        },
                        {
                          label: "Total Fat",
                          value: product.nutriments.fat != null ? `${product.nutriments.fat}g` : "—",
                          dot: null,
                        },
                        {
                          label: "Sat. Fat",
                          value: product.nutriments.saturatedFat != null ? `${product.nutriments.saturatedFat}g` : "—",
                          dot: "bg-signal-red-orange",
                        },
                        {
                          label: "Sugars",
                          value: product.nutriments.sugars != null ? `${product.nutriments.sugars}g` : "—",
                          dot: "bg-sunset-orange",
                        },
                        {
                          label: "Salt / Sodium",
                          value: product.nutriments.salt != null ? `${product.nutriments.salt}g` : "—",
                          dot: null,
                        },
                        {
                          label: "Protein",
                          value: product.nutriments.proteins != null ? `${product.nutriments.proteins}g` : "—",
                          dot: "bg-verdant-green",
                        },
                        {
                          label: "Dietary Fiber",
                          value: product.nutriments.fiber != null ? `${product.nutriments.fiber}g` : "—",
                          dot: null,
                        },
                      ].map((n) => (
                        <div key={n.label} className="min-w-0 rounded-2xl bg-fog p-3.5">
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {n.dot && <span className={`h-2 w-2 shrink-0 rounded-full ${n.dot}`} aria-hidden="true" />}
                            <span className="truncate">{n.label}</span>
                          </p>
                          <p className="fn-metric mt-2 text-lg text-graphite">{n.value}</p>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Ingredients Section */}
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-x-4">
                      <h3 className="text-base font-bold text-graphite">
                        Ingredients List (as declared on package)
                      </h3>
                      <Button
                        variant="link"
                        className="h-11 px-0 text-sm"
                        disabled={bridging}
                        onClick={handleAnalyzeWithAI}
                      >
                        Deep AI Analysis <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="rounded-2xl bg-fog p-4 text-sm leading-relaxed text-graphite md:p-5">
                      {product.ingredientsText || "No ingredient list specified on this product entry."}
                    </div>

                    {product.allergens && product.allergens.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <span className="flex items-center gap-1.5 text-sm font-bold text-graphite">
                          <AlertCircle className="h-4 w-4 text-signal-red-orange" /> Contains Allergens:
                        </span>
                        {product.allergens.map((alg: string) => (
                          <StatusTag key={alg} tone="negative" className="capitalize">
                            {alg}
                          </StatusTag>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </article>
            ) : (
              <div className="flex flex-col items-center rounded-3xl bg-white px-5 py-14 text-center">
                <span className="grid h-14 w-14 place-items-center rounded-3xl bg-fog">
                  <Barcode className="h-7 w-7 text-ember-orange" />
                </span>
                <p className="mt-5 break-words font-bold text-graphite">
                  No product found for barcode &ldquo;{activeBarcode}&rdquo;.
                </p>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  Try searching by product name in the next tab or use one of the demo barcodes.
                </p>
              </div>
            )}
          </TabsContent>

          {/* TAB 2: Global Search */}
          <TabsContent value="search" className="space-y-6">
            <section className="space-y-6 rounded-3xl bg-white p-5 md:p-7">
              <div className="flex items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog">
                  <Search className="h-5 w-5 text-ember-orange" />
                </span>
                <div className="min-w-0 space-y-1">
                  <h2 className="text-lg font-bold text-graphite">Search Global Food Catalog</h2>
                  <p className="text-sm text-muted-foreground">
                    Search millions of packaged foods by brand or name (e.g., Maggi, Amul, Oreo, Lays, Nutella).
                  </p>
                </div>
              </div>
              <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="e.g., Maggi Noodles or Amul Butter..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-12 text-base"
                    aria-label="Product name"
                  />
                </div>
                <Button type="submit">
                  <Search className="h-4 w-4" /> Search
                </Button>
              </form>
            </section>

            {isSearchLoading ? (
              <div role="status" className="flex flex-col items-center gap-3 rounded-3xl bg-white px-5 py-16 text-center text-muted-foreground">
                <Loader2 className="h-7 w-7 animate-spin text-ember-orange" aria-hidden="true" />
                <p className="text-sm">Searching Open Food Facts...</p>
              </div>
            ) : isSearchError ? (
              <div role="alert" className="flex flex-col items-center rounded-3xl bg-white px-5 py-14 text-center">
                <span className="grid h-14 w-14 place-items-center rounded-3xl bg-fog">
                  <AlertCircle className="h-7 w-7 text-signal-red-orange" />
                </span>
                <p className="mt-5 font-bold text-graphite">Search is unavailable</p>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  {searchError?.message ?? "Please check your connection and try again."}
                </p>
                <Button variant="outline" className="mt-6" onClick={() => refetchSearch()}>
                  Try again
                </Button>
              </div>
            ) : searchResults.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
                {searchResults.map((item: any, idx: number) => (
                  <article
                    key={`${item.barcode}-${idx}`}
                    className="flex min-w-0 flex-col rounded-3xl border border-border bg-white"
                  >
                    <div className="flex items-start gap-4 p-5 pb-3">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.productName}
                          className="h-16 w-16 shrink-0 rounded-2xl border border-border bg-white object-contain p-1"
                        />
                      ) : (
                        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-fog">
                          <Package className="h-7 w-7 text-ember-orange" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-1 text-base font-bold text-graphite">
                          {item.productName}
                        </h3>
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {[item.brand && item.brand.toLowerCase() !== "generic" ? item.brand : null, item.category].filter(Boolean).join(" · ")}
                        </p>
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {item.nutriscoreGrade && (
                            <span className="inline-flex items-center gap-1.5 rounded-3xl bg-fog py-1 pl-1 pr-2.5 text-xs font-bold text-graphite">
                              <span
                                className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-extrabold ${getNutriscoreColor(item.nutriscoreGrade)}`}
                              >
                                {item.nutriscoreGrade}
                              </span>
                              Nutri-Score {item.nutriscoreGrade}
                            </span>
                          )}
                          {item.novaGroup && (
                            <span className="inline-flex items-center gap-1.5 rounded-3xl bg-fog py-1 pl-1 pr-2.5 text-xs font-bold text-graphite">
                              <span
                                className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-extrabold ${getNovaColor(item.novaGroup)}`}
                              >
                                {item.novaGroup}
                              </span>
                              NOVA {item.novaGroup}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <p className="line-clamp-2 px-5 pb-4 text-xs leading-relaxed text-muted-foreground">
                      {item.ingredientsText || "No ingredient text available."}
                    </p>
                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                      <Button
                        variant="ghost"
                        className="px-3"
                        disabled={!item.barcode}
                        onClick={() => {
                          setBarcodeInput(item.barcode);
                          setActiveBarcode(item.barcode);
                          setActiveTab("barcode");
                        }}
                      >
                        <Barcode className="h-4 w-4" /> View Barcode
                      </Button>

                      {item.ingredientsText && (
                        <Button
                          variant="dark"
                          className="px-4"
                          disabled={bridging}
                          onClick={async () => {
                            if (bridging) return;
                            const toastId = toast.loading("Analyzing with IngreScan-AI...");
                            setBridging(true);
                            try {
                              const scanRes = await createScanMutation.mutateAsync({
                                productName: formatProductTitle(item.brand, item.productName),
                                inputType: "text",
                                rawIngredients: item.ingredientsText,
                                imageUrl: item.imageUrl || undefined,
                              });
                              await analyzeMutation.mutateAsync({
                                scanId: scanRes.scanId,
                                ingredients: item.ingredientsText,
                              });
                              toast.success("Done!", { id: toastId });
                              setLocation(`/scan/${scanRes.scanId}`);
                            } catch (e: any) {
                              toast.error(e.message, { id: toastId });
                            } finally {
                              setBridging(false);
                            }
                          }}
                        >
                          <Sparkles className="h-4 w-4" /> AI Scan
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : submittedQuery ? (
              <div className="rounded-3xl bg-white px-5 py-16 text-center text-sm text-muted-foreground">
                No products found for &ldquo;{submittedQuery}&rdquo;. Try another term.
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
