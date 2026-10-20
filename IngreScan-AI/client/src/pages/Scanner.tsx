import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Upload, Type, Loader2, Camera, Package, ScanLine, Barcode as BarcodeIcon, AlertCircle, CheckCircle2, RefreshCw, Database } from "lucide-react";
import { PageHeader } from "@/components/brand/PageHeader";
import { ProfileCompletionBanner } from "@/components/ProfileCompletionBanner";
import { StatusTag } from "@/components/brand/StatusTag";
import { BarcodeScanner, type ScannedBarcode } from "@/components/BarcodeScanner";
import { decodeBarcodeFromFile } from "@/lib/barcodeDecode";

type InputType = "text" | "image" | "barcode";

type OffProductView = {
  barcode: string;
  productName: string;
  brand: string;
  imageUrl: string | null;
  ingredientsText: string;
  nutriscoreGrade: string | null;
  novaGroup: number | null;
  allergens: string[];
};

const GRADE_COLORS: Record<string, string> = {
  A: "bg-verdant-ink",
  B: "bg-sky-ink",
  C: "bg-amber-ink",
  D: "bg-ember-deep",
  E: "bg-alert-ink",
};
const NOVA_COLORS: Record<number, string> = {
  1: "bg-verdant-ink",
  2: "bg-sky-ink",
  3: "bg-amber-ink",
  4: "bg-negative-ink",
};

/** "Brand Product" without the placeholder brand the server uses when OFF has none. */
function displayName(p: Pick<OffProductView, "brand" | "productName">): string {
  const brand = p.brand && p.brand !== "Generic" ? p.brand : "";
  const name = p.productName && p.productName !== "Unknown Product" ? p.productName : "";
  return [brand, name].filter(Boolean).join(" ").slice(0, 255);
}

function ProductSummary({ product }: { product: OffProductView }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center" data-testid="off-product-card">
      {product.imageUrl ? (
        <img src={product.imageUrl} alt={product.productName} className="h-20 w-20 shrink-0 rounded-2xl border border-border bg-white object-contain p-1" />
      ) : (
        <div className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl bg-white">
          <Package className="h-8 w-8 text-ember-orange" />
        </div>
      )}
      <div className="min-w-0 space-y-2">
        <div>
          <p className="break-words text-lg font-bold text-graphite" data-testid="off-product-name">{product.productName}</p>
          {product.brand && product.brand !== "Generic" && <p className="text-sm font-medium text-muted-foreground">{product.brand}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag onWhite className="font-mono">Barcode {product.barcode}</StatusTag>
          {product.nutriscoreGrade && (
            <span className="inline-flex items-center gap-2 rounded-3xl bg-white px-3 py-1 text-xs font-bold text-graphite">
              <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] text-white ${GRADE_COLORS[product.nutriscoreGrade] ?? "bg-muted-foreground"}`}>{product.nutriscoreGrade}</span>
              Nutri-Score
            </span>
          )}
          {product.novaGroup && (
            <span className="inline-flex items-center gap-2 rounded-3xl bg-white px-3 py-1 text-xs font-bold text-graphite">
              <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] text-white ${NOVA_COLORS[product.novaGroup] ?? "bg-muted-foreground"}`}>{product.novaGroup}</span>
              NOVA
            </span>
          )}
          {product.allergens.length > 0 && (
            <StatusTag tone="caution" onWhite>Allergens: {product.allergens.join(", ")}</StatusTag>
          )}
        </div>
      </div>
    </div>
  );
}

function Notice({ icon: Icon, tone = "info", children, testId }: { icon: typeof AlertCircle; tone?: "info" | "error" | "ok"; children: React.ReactNode; testId?: string }) {
  const color = tone === "error" ? "text-signal-red-orange" : tone === "ok" ? "text-verdant-green" : "text-ember-orange";
  return (
    <div role={tone === "error" ? "alert" : "status"} className="flex items-start gap-3 rounded-3xl bg-fog p-4" data-testid={testId}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${color}`} />
      <div className="min-w-0 space-y-2 text-sm font-medium text-graphite">{children}</div>
    </div>
  );
}

export default function Scanner() {
  const [, setLocation] = useLocation();
  const { data: profile, isLoading: profileLoading } = trpc.profile.get.useQuery();
  const [inputType, setInputType] = useState<InputType>("text");
  const [productName, setProductName] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Barcode mode: the code the user scanned/typed, and the edited ingredient text keyed by that code
  const [scanned, setScanned] = useState<ScannedBarcode | null>(null);
  const [offEdit, setOffEdit] = useState<{ code: string; text: string } | null>(null);
  // Hybrid: barcode decoded from the label photo chosen in Image mode
  const [photoDetect, setPhotoDetect] = useState<"idle" | "detecting" | "done">("idle");
  const [photoScan, setPhotoScan] = useState<ScannedBarcode | null>(null);
  /** Barcode seen in the photo but its check digit failed. code is null when the digits could not be read at all. */
  const [photoInvalid, setPhotoInvalid] = useState<{ code: string | null } | null>(null);
  const [forceOcr, setForceOcr] = useState(false);
  const detectAbortRef = useRef<AbortController | null>(null);
  const autoNameRef = useRef<string>("");

  // Pre-fill product name when arriving from the Expiry Tracker (/scanner?prefill=...)
  useEffect(() => {
    try {
      const prefill = new URLSearchParams(window.location.search).get("prefill");
      if (prefill) setProductName(prefill);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => () => detectAbortRef.current?.abort(), []);

  const uploadImageMutation = trpc.scanner.uploadImage.useMutation();
  const createScanMutation = trpc.scanner.createScan.useMutation();
  const processOCRMutation = trpc.scanner.processOCR.useMutation();
  const deleteScanMutation = trpc.scanner.deleteScan.useMutation();
  const analyzeIngredientsMutation = trpc.analysis.analyzeIngredients.useMutation();

  // Open Food Facts lookups (cached for 5 minutes in the browser, and in server memory as well)
  const lookupOpts = { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } as const;
  const barcodeQuery = trpc.openFoodFacts.getByBarcode.useQuery(
    { barcode: scanned?.lookupCode ?? "" },
    { ...lookupOpts, enabled: !!scanned },
  );
  const photoQuery = trpc.openFoodFacts.getByBarcode.useQuery(
    { barcode: photoScan?.lookupCode ?? "" },
    { ...lookupOpts, enabled: !!photoScan },
  );

  const barcodeProduct = scanned ? barcodeQuery.data ?? null : null;
  const photoProduct = photoScan ? photoQuery.data ?? null : null;
  const effectiveIngredients = (code: string, p: OffProductView | null) =>
    offEdit && offEdit.code === code ? offEdit.text : p?.ingredientsText ?? "";

  const barcodeIngredients = barcodeProduct ? effectiveIngredients(barcodeProduct.barcode, barcodeProduct) : "";
  const photoIngredients = photoProduct ? effectiveIngredients(photoProduct.barcode, photoProduct) : "";
  // The hybrid path replaces OCR only when the photo had a valid barcode, OFF knows the product and it has ingredient text.
  const hybridActive = !forceOcr && !!photoProduct && !!(photoProduct.ingredientsText?.trim());

  // Auto-fill the product name from Open Food Facts, but never overwrite something the user typed.
  const nameSource = inputType === "barcode" ? barcodeProduct : inputType === "image" && hybridActive ? photoProduct : null;
  useEffect(() => {
    if (!nameSource) return;
    const auto = displayName(nameSource);
    if (!auto) return;
    setProductName((current) => {
      if (!current.trim() || current === autoNameRef.current) {
        autoNameRef.current = auto;
        return auto;
      }
      return current;
    });
  }, [nameSource?.barcode, nameSource?.productName]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBarcodeDetected = (b: ScannedBarcode) => {
    setOffEdit(null);
    setScanned(b);
  };

  const clearImage = () => {
    detectAbortRef.current?.abort();
    setImageFile(null);
    setImagePreview(null);
    setPhotoDetect("idle");
    setPhotoScan(null);
    setPhotoInvalid(null);
    setForceOcr(false);
  };

  const [dragOver, setDragOver] = useState(false);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // allow re-selecting the same file
    acceptImageFile(file);
  };

  const acceptImageFile = (file: File | undefined) => {
    if (file && !isProcessing) {
      if (!file.type.startsWith("image/")) {
        toast.error("Please select an image file");
        return;
      }
      if (file.size > 16 * 1024 * 1024) {
        toast.error("File size must be less than 16MB");
        return;
      }
      setImageFile(file);
      const reader = new FileReader();
      reader.onload = () => setImagePreview(reader.result as string);
      reader.onerror = () => {
        setImageFile(null);
        toast.error("Could not read the selected file");
      };
      reader.readAsDataURL(file);

      // Hybrid: look for a barcode in the photo first. A product with ingredient text on Open Food Facts makes OCR unnecessary.
      detectAbortRef.current?.abort();
      const ac = new AbortController();
      detectAbortRef.current = ac;
      setPhotoScan(null);
      setPhotoInvalid(null);
      setForceOcr(false);
      setPhotoDetect("detecting");
      decodeBarcodeFromFile(file, { signal: ac.signal })
        .then((result) => {
          if (ac.signal.aborted) return;
          if (result.status === "found" && result.best.check.ok) {
            const c = result.best.check;
            setPhotoScan({ code: c.code, lookupCode: c.lookupCode, format: c.format, source: "photo", checksumValid: true });
          } else if (result.status === "invalid" && !result.best.check.ok) {
            setPhotoInvalid({ code: result.best.check.code });
          }
        })
        .catch(() => undefined) // detection is best-effort; OCR still works
        .finally(() => {
          if (!ac.signal.aborted) setPhotoDetect("done");
        });
    }
  };

  const runAnalysis = async (scanId: number, rawIngredients: string) => {
    toast.info("Analyzing ingredients...");
    await analyzeIngredientsMutation.mutateAsync({ scanId, ingredients: rawIngredients });
    toast.success("Analysis complete!");
    setLocation(`/scan/${scanId}`);
  };

  /** Barcode path: Open Food Facts ingredient text, no OCR and no vision-LLM call. */
  const submitFromOff = async (product: OffProductView, rawIngredients: string) => {
    const name = productName.trim() || displayName(product) || undefined;
    const { scanId } = await createScanMutation.mutateAsync({
      productName: name,
      inputType: "text",
      rawIngredients,
      imageUrl: product.imageUrl && product.imageUrl.length <= 2000 ? product.imageUrl : undefined,
    });
    await runAnalysis(scanId, rawIngredients);
  };

  /** Handle OCR scanning cleanly; deletes draft scan record if OCR fails or yields no text. */
  const handleOCRScan = async (scanId: number, imageUrl: string) => {
    toast.info("Extracting ingredients from image...");
    try {
      const ocrResult = await processOCRMutation.mutateAsync({
        scanId,
        imageUrl,
      });
      const ocrText = ocrResult?.ocrText?.trim();
      if (!ocrText) {
        throw new Error("No ingredients could be extracted");
      }
      return ocrText;
    } catch (ocrErr: any) {
      try {
        await deleteScanMutation.mutateAsync({ scanId });
      } catch {
        // ignore delete cleanup error
      }
      throw ocrErr;
    }
  };

  const handleSubmit = async () => {
    setIsProcessing(true);
    try {
      if (inputType === "barcode") {
        if (!barcodeProduct || !barcodeIngredients.trim()) {
          toast.error("Scan a barcode with a known ingredient list first");
          return;
        }
        await submitFromOff(barcodeProduct, barcodeIngredients.trim());
        return;
      }
      if (inputType === "image" && hybridActive && photoProduct) {
        if (!photoIngredients.trim()) {
          toast.error("Please enter ingredients");
          return;
        }
        await submitFromOff(photoProduct, photoIngredients.trim());
        return;
      }

      let scanData: any = { productName: productName.trim() || undefined, inputType };

      if (inputType === "image" && imageFile) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Could not read the selected file"));
          reader.readAsDataURL(imageFile);
        });
        const base64 = dataUrl.split(",")[1] ?? "";
        
        const uploadResult = await uploadImageMutation.mutateAsync({
          fileName: imageFile.name,
          fileData: base64,
          mimeType: imageFile.type,
        });
        
        scanData.imageUrl = uploadResult.url;
        scanData.imageKey = uploadResult.fileKey;
      } else if (inputType === "text") {
        if (!ingredients.trim()) {
          toast.error("Please enter ingredients");
          return;
        }
        scanData.rawIngredients = ingredients;
      }

      const { scanId } = await createScanMutation.mutateAsync(scanData);

      if (inputType === "image" && scanData.imageUrl) {
        scanData.rawIngredients = await handleOCRScan(scanId, scanData.imageUrl);
      }

      if (!scanData.rawIngredients || !String(scanData.rawIngredients).trim()) {
        throw new Error("No ingredients could be extracted");
      }

      await runAnalysis(scanId, scanData.rawIngredients);
    } catch (error: any) {
      toast.error(error.message || "Failed to process scan");
    } finally {
      setIsProcessing(false);
    }
  };

  // ---- Barcode tab state ----
  const lookupErrorCode = (barcodeQuery.error as any)?.data?.code as string | undefined;
  const outage = barcodeQuery.isError && lookupErrorCode === "SERVICE_UNAVAILABLE";
  const checksumWarned = scanned && !scanned.checksumValid;

  const submitDisabled =
    isProcessing ||
    (inputType === "text" && !ingredients.trim()) ||
    (inputType === "image" && (
      !imageFile ||
      photoDetect === "detecting" ||
      (!!photoScan && photoQuery.isFetching && !forceOcr) ||
      (hybridActive && !photoIngredients.trim())
    )) ||
    (inputType === "barcode" && (!barcodeProduct || !barcodeIngredients.trim()));

  const ingredientEditor = (code: string, value: string, id: string) => (
    <div className="space-y-2">
      <Label htmlFor={id} className="font-bold text-graphite">Ingredients (editable)</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => setOffEdit({ code, text: e.target.value })}
        rows={6}
        disabled={isProcessing}
        className="min-h-36"
      />
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Database className="h-3.5 w-3.5" />
        Source: Open Food Facts (community data). Check it against the pack and fix anything that differs.
      </p>
    </div>
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl space-y-8 md:space-y-10">
        <PageHeader
          eyebrow="Scan"
          title="Ingredient Scanner"
          description="Scan a barcode, upload a label photo, or enter ingredients manually"
        />

        <ProfileCompletionBanner hasProfile={!!profile || profileLoading} />

        <Card>
          <CardHeader>
            <div className="flex items-start gap-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
                <Package className="h-5 w-5 text-ember-orange" />
              </span>
              <div className="min-w-0 space-y-1">
                <CardTitle>Product Information</CardTitle>
                <CardDescription>Start by entering the product name</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="productName" className="font-bold text-graphite">
                Product Name <span className="font-medium text-muted-foreground">(Optional)</span>
              </Label>
              <Input
                id="productName"
                placeholder="e.g., Bournvita, Maggi Noodles"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                disabled={isProcessing}
              />
            </div>
          </CardContent>
        </Card>

        <Tabs value={inputType} onValueChange={(v) => setInputType(v as InputType)} className="gap-4">
          <TabsList className="grid h-12 w-full grid-cols-3 bg-white">
            <TabsTrigger value="text" className="px-2 data-[state=active]:bg-graphite data-[state=active]:text-white">
              <Type className="h-4 w-4" /><span className="sm:hidden">Text</span><span className="hidden sm:inline">Text Input</span>
            </TabsTrigger>
            <TabsTrigger value="image" className="px-2 data-[state=active]:bg-graphite data-[state=active]:text-white">
              <Upload className="h-4 w-4" /><span className="sm:hidden">Image</span><span className="hidden sm:inline">Image Upload</span>
            </TabsTrigger>
            <TabsTrigger value="barcode" className="px-2 data-[state=active]:bg-graphite data-[state=active]:text-white">
              <BarcodeIcon className="h-4 w-4" />Barcode
            </TabsTrigger>
          </TabsList>

          <TabsContent value="text">
            <Card>
              <CardHeader>
                <div className="flex items-start gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
                    <Type className="h-5 w-5 text-ember-orange" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <CardTitle>Enter Ingredients</CardTitle>
                    <CardDescription>Type or paste the ingredient list</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Textarea
                  placeholder="e.g., Sugar, Maltodextrin, Cocoa Solids, Milk Solids, Liquid Glucose..."
                  value={ingredients}
                  onChange={(e) => setIngredients(e.target.value)}
                  rows={8}
                  disabled={isProcessing}
                  className="min-h-48"
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="image">
            <Card>
              <CardHeader>
                <div className="flex items-start gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
                    <Camera className="h-5 w-5 text-ember-orange" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <CardTitle>Upload Label Image</CardTitle>
                    <CardDescription>Take a clear photo of the ingredient label. If a barcode is visible we use it instead of reading the text.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {imagePreview ? (
                  <div className="space-y-4 rounded-3xl bg-fog p-4 text-center sm:p-6">
                    <img src={imagePreview} alt="Preview" className="mx-auto max-h-64 max-w-full rounded-2xl" />
                    <Button variant="outline" onClick={clearImage} disabled={isProcessing}>
                      Change Image
                    </Button>
                  </div>
                ) : (
                  <div>
                    {/* Visually hidden but focusable (not display:none) so keyboard users can reach the picker. */}
                    <input
                      id="imageUpload"
                      type="file"
                      accept="image/*"
                      onChange={handleImageChange}
                      className="peer sr-only"
                      disabled={isProcessing}
                    />
                    <Label
                      htmlFor="imageUpload"
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        acceptImageFile(e.dataTransfer.files?.[0]);
                      }}
                      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed bg-fog px-6 py-10 text-center transition-colors hover:border-ember-orange peer-focus-visible:border-ember-orange peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 sm:py-14 ${dragOver ? "border-ember-orange" : "border-[#dcdcdc]"}`}
                    >
                      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white" aria-hidden="true">
                        <Upload className="h-6 w-6 text-ember-orange" />
                      </span>
                      <span className="text-base font-bold text-graphite">Click to upload or drag and drop</span>
                      <span className="text-sm font-medium text-muted-foreground">PNG, JPG up to 16MB</span>
                    </Label>
                  </div>
                )}

                {imageFile && photoDetect === "detecting" && (
                  <Notice icon={Loader2} testId="hybrid-detecting">
                    <p>Checking the photo for a barcode...</p>
                  </Notice>
                )}
                {imageFile && photoInvalid && !photoScan && (
                  <Notice icon={AlertCircle} tone="error" testId="hybrid-invalid">
                    <p>
                      {photoInvalid.code ? `A barcode was read as ${photoInvalid.code}` : "A barcode was detected"}, but its check digit does not match, so it may be a misread. We will read the label text with OCR instead. To use the barcode, open the Barcode tab and type or re-scan the number.
                    </p>
                  </Notice>
                )}
                {imageFile && photoScan && photoQuery.isFetching && (
                  <Notice icon={Loader2} testId="hybrid-lookup">
                    <p>Barcode {photoScan.code} found in the photo. Looking it up on Open Food Facts...</p>
                  </Notice>
                )}
                {imageFile && photoScan && !photoQuery.isFetching && hybridActive && photoProduct && (
                  <div className="space-y-4 rounded-3xl bg-fog p-4" data-testid="hybrid-active">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verdant-green" />
                      <p className="text-sm font-medium text-graphite">
                        Barcode {photoScan.code} found in your photo and matched on Open Food Facts. We will use its ingredient list and skip OCR.
                      </p>
                    </div>
                    <ProductSummary product={photoProduct} />
                    {ingredientEditor(photoProduct.barcode, photoIngredients, "hybridIngredients")}
                    <Button variant="outline" size="sm" onClick={() => setForceOcr(true)} disabled={isProcessing} data-testid="force-ocr">
                      <RefreshCw className="h-4 w-4" />
                      Read the label with OCR instead
                    </Button>
                  </div>
                )}
                {imageFile && photoScan && !photoQuery.isFetching && !hybridActive && forceOcr && (
                  <Notice icon={ScanLine} testId="hybrid-forced-ocr">
                    <p>The label text will be read with OCR.</p>
                    <Button variant="outline" size="sm" onClick={() => setForceOcr(false)} disabled={isProcessing}>
                      Use Open Food Facts data again
                    </Button>
                  </Notice>
                )}
                {imageFile && photoScan && !photoQuery.isFetching && !forceOcr && !hybridActive && (
                  <Notice icon={photoQuery.isError ? AlertCircle : ScanLine} tone={photoQuery.isError ? "error" : "info"} testId="hybrid-fallback">
                    <p>
                      {photoQuery.isError
                        ? `Barcode ${photoScan.code} found, but Open Food Facts is unreachable right now. The label text will be read with OCR.`
                        : photoProduct
                          ? `Barcode ${photoScan.code} matched ${photoProduct.productName} on Open Food Facts, but it has no ingredient list. The label text will be read with OCR.`
                          : `Barcode ${photoScan.code} is not in Open Food Facts. The label text will be read with OCR.`}
                    </p>
                  </Notice>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="barcode">
            <Card>
              <CardHeader>
                <div className="flex items-start gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
                    <BarcodeIcon className="h-5 w-5 text-ember-orange" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <CardTitle>Scan Barcode</CardTitle>
                    <CardDescription>Instant product match from Open Food Facts. No photo reading needed when the product is known.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <BarcodeScanner onDetected={handleBarcodeDetected} disabled={isProcessing} idPrefix="scanner-barcode" />

                {scanned && (
                  <div className="space-y-4" data-testid="barcode-result">
                    {checksumWarned && (
                      <Notice icon={AlertCircle} tone="error" testId="barcode-checksum-warning">
                        <p>The check digit of {scanned.code} does not match, so this number may be wrong. Showing what Open Food Facts has for it.</p>
                      </Notice>
                    )}

                    {barcodeQuery.isLoading && (
                      <Notice icon={Loader2} testId="barcode-loading">
                        <p>Looking up {scanned.lookupCode} on Open Food Facts...</p>
                      </Notice>
                    )}

                    {outage && (
                      <Notice icon={AlertCircle} tone="error" testId="barcode-outage">
                        <p className="font-bold">Open Food Facts is unreachable right now.</p>
                        <p>This is a temporary problem with the database, not a missing product. Try again in a moment, or read the label photo instead.</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button size="sm" variant="outline" onClick={() => barcodeQuery.refetch()} disabled={barcodeQuery.isFetching}>
                            {barcodeQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            Try again
                          </Button>
                          <Button size="sm" variant="dark" onClick={() => setInputType("image")}>
                            <Upload className="h-4 w-4" />
                            Use Image (OCR) mode
                          </Button>
                        </div>
                      </Notice>
                    )}

                    {barcodeQuery.isError && !outage && (
                      <Notice icon={AlertCircle} tone="error" testId="barcode-lookup-error">
                        <p className="font-bold">The barcode lookup failed.</p>
                        <p>{barcodeQuery.error?.message || "Something went wrong."}</p>
                        <Button size="sm" variant="outline" onClick={() => barcodeQuery.refetch()}>Try again</Button>
                      </Notice>
                    )}

                    {barcodeQuery.isSuccess && !barcodeProduct && (
                      <Notice icon={AlertCircle} testId="barcode-not-found">
                        <p className="font-bold">Product {scanned.lookupCode} is not in Open Food Facts.</p>
                        <p>Photograph the ingredient label and we will read it for you, or check the number and try again.</p>
                        <Button size="sm" variant="dark" onClick={() => setInputType("image")}>
                          <Upload className="h-4 w-4" />
                          Use Image (OCR) mode
                        </Button>
                      </Notice>
                    )}

                    {barcodeProduct && (
                      <div className="space-y-4 rounded-3xl bg-fog p-4 sm:p-5">
                        <ProductSummary product={barcodeProduct} />
                        {barcodeProduct.ingredientsText.trim() || offEdit?.code === barcodeProduct.barcode ? (
                          ingredientEditor(barcodeProduct.barcode, barcodeIngredients, "barcodeIngredients")
                        ) : (
                          <Notice icon={AlertCircle} testId="barcode-no-ingredients">
                            <p className="font-bold">Open Food Facts has this product but no ingredient list.</p>
                            <p>The product name is filled in above. Photograph the ingredient label and we will read it, or type the ingredients in Text mode.</p>
                            <Button size="sm" variant="dark" onClick={() => setInputType("image")}>
                              <Upload className="h-4 w-4" />
                              Use Image (OCR) mode
                            </Button>
                          </Notice>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" size="lg" onClick={() => setLocation("/dashboard")} disabled={isProcessing} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button
            size="lg"
            onClick={handleSubmit}
            disabled={submitDisabled}
            className="w-full sm:w-auto"
          >
            {isProcessing ? <><Loader2 className="h-4 w-4 animate-spin" />Processing...</> : <><ScanLine className="h-4 w-4" />Analyze Ingredients</>}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}
