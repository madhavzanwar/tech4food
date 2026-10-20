import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Info, Loader2, PlusCircle, ScanLine, TriangleAlert, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusTag } from "@/components/brand/StatusTag";
import { trpc } from "@/lib/trpc";
import { toLocalDateInput } from "@/lib/utils";

type Freshness = "fresh" | "normal" | "rotten";

interface DetectedItem {
  box: { x: number; y: number; w: number; h: number };
  detector_label: string;
  detector_score: number;
  fruit: string;
  fruit_kr: string;
  confidence: number;
  p_fresh: number;
  freshness_status: Freshness;
  shelf_life_days: number;
  storage_tips: string;
  image_url: string;
  /** Present when the server ran the consistency checks; such items start unticked. */
  needs_check?: boolean;
  check_reasons?: string[];
  source?: "detector" | "second_pass";
  produce_likelihood?: number;
}

const CHECK_REASON_TEXT: Record<string, string> = {
  label_mismatch: "The box finder and the freshness model disagree about the type.",
  low_produce_likelihood: "This might not be fresh produce.",
  ambiguous_type: "Two types look alike here.",
  second_pass: "Found by the extra search, not the main finder.",
};

interface DetectResponse {
  items: DetectedItem[];
  rejected: Array<{ box: DetectedItem["box"]; fruit: string; confidence: number; reason?: string }>;
  image: { width: number; height: number };
  min_confidence: number;
  detector: { model: string; license: string; classes: string[] };
}

interface FruitMeta {
  code: string;
  name_kr: string;
  storage: string;
  shelf_life_days: Record<string, number>;
}

interface Row extends DetectedItem {
  selected: boolean;
  chosenFruit: string;
}

const MAX_SIDE = 1600;
const FEW_ITEMS = 2;

/** Downscale to at most MAX_SIDE px and re-encode as JPEG so uploads stay small and fast. */
async function prepareImage(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Could not read the selected file"));
    r.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = original;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return original; // let the server decide whether the file is usable
  }
}

const tone = (s: string) => (s === "fresh" ? "positive" : s === "normal" ? "caution" : "negative");
const strokeFor = (s: string) =>
  s === "fresh" ? "var(--fn-verdant-green)" : s === "normal" ? "var(--fn-sunset-orange)" : "var(--fn-signal-red-orange)";

export function ShelfScan({ onAdded, onUseSingle }: { onAdded: (allAdded: boolean) => void | Promise<void>; onUseSingle: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [meta, setMeta] = useState<DetectResponse | null>(null);
  const [error, setError] = useState<{ message: string; notInstalled: boolean } | null>(null);
  const [fruits, setFruits] = useState<FruitMeta[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const addInventory = trpc.produce.addInventory.useMutation();

  useEffect(() => {
    fetch("/api/freshguard/fruits")
      .then(r => (r.ok ? r.json() : []))
      .then(d => setFruits(Array.isArray(d) ? d : []))
      .catch(() => setFruits([]));
  }, []);

  const fruitByCode = useMemo(() => new Map(fruits.map(f => [f.code, f])), [fruits]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    setBusy(true);
    setError(null);
    setRows(null);
    setMeta(null);
    try {
      const dataUrl = await prepareImage(file);
      setPreview(dataUrl);
      const res = await fetch("/api/freshguard/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError({
          message: body?.error || `Detection failed (HTTP ${res.status}).`,
          notInstalled: res.status === 503 || body?.code === "detector_not_installed",
        });
        return;
      }
      const data = (await res.json()) as DetectResponse;
      setMeta(data);
      // Items that need a check start unticked: the user ticks them to confirm ("use anyway").
      setRows(data.items.map(it => ({ ...it, selected: !it.needs_check, chosenFruit: it.fruit })));
      if (data.items.length > 0) toast.success(`Found ${data.items.length} item${data.items.length === 1 ? "" : "s"}.`);
    } catch (err: any) {
      setError({ message: err?.message || "Detection failed.", notInstalled: false });
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Row>) =>
    setRows(prev => (prev ? prev.map((r, k) => (k === i ? { ...r, ...patch } : r)) : prev));

  const selectedCount = rows?.filter(r => r.selected).length ?? 0;

  const displayName = (r: Row) => fruitByCode.get(r.chosenFruit)?.name_kr ?? r.fruit_kr;

  const addSelected = async () => {
    if (!rows) return;
    const chosen = rows.filter(r => r.selected);
    if (chosen.length === 0) return;
    setAdding(true);
    const done = new Set<number>();
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.selected) continue;
        const info = fruitByCode.get(r.chosenFruit);
        const days = Math.max(0, info?.shelf_life_days?.[r.freshness_status] ?? r.shelf_life_days ?? 3);
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + days);
        await addInventory.mutateAsync({
          name: displayName(r),
          fruit: r.chosenFruit,
          freshness: r.freshness_status,
          pFresh: r.p_fresh,
          confidence: r.confidence,
          imageUrl: r.image_url,
          storageTip: info?.storage ?? r.storage_tips,
          expiryDate: toLocalDateInput(expiry),
        });
        done.add(i);
      }
      toast.success(`Added ${done.size} item${done.size === 1 ? "" : "s"} to your Fridge Pantry.`);
    } catch (err: any) {
      toast.error(`${err?.message || "Failed to add items"} (${done.size} of ${chosen.length} were added).`);
    } finally {
      // Items already saved leave the list so a retry cannot add them twice.
      setRows(prev => (prev ? prev.filter((_, i) => !done.has(i)) : prev));
      setAdding(false);
    }
    if (done.size > 0) await onAdded(done.size === chosen.length);
  };

  const W = meta?.image.width ?? 1;
  const H = meta?.image.height ?? 1;
  const fewItems = rows !== null && meta !== null && meta.items.length < FEW_ITEMS;
  const checkCount = rows?.filter(r => r.needs_check).length ?? 0;
  const notProduceCount = meta?.rejected.filter(r => r.reason === "not_produce").length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start" data-testid="shelf-scan">
      <div className="lg:col-span-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog">
                <ScanLine className="h-5 w-5 text-ember-orange" />
              </span>
              Scan a whole shelf
            </CardTitle>
            <CardDescription>
              Take one photo of a shelf or a bowl. Each item is found, checked for freshness, and listed for you to review.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="relative overflow-hidden rounded-2xl bg-fog" data-testid="shelf-preview">
              {preview ? (
                <div className="relative">
                  <img src={preview} alt="Shelf preview" className="block h-auto w-full" />
                  {meta && (
                    <svg
                      viewBox={`0 0 ${W} ${H}`}
                      className="absolute inset-0 h-full w-full"
                      data-testid="shelf-overlay"
                      aria-hidden="true"
                    >
                      {rows?.map((r, i) => {
                        const fs = Math.max(14, Math.round(W / 40));
                        return (
                          <g key={i} opacity={r.selected ? 1 : 0.5}>
                            <rect
                              x={r.box.x}
                              y={r.box.y}
                              width={r.box.w}
                              height={r.box.h}
                              fill="none"
                              stroke={strokeFor(r.freshness_status)}
                              strokeWidth={Math.max(2, W / 300)}
                              strokeDasharray={r.selected && !r.needs_check ? undefined : "8 6"}
                              rx={4}
                            />
                            <rect x={r.box.x} y={r.box.y} width={fs * 1.6} height={fs * 1.4} fill={strokeFor(r.freshness_status)} rx={3} />
                            <text x={r.box.x + fs * 0.8} y={r.box.y + fs * 1.05} fontSize={fs} fontWeight="700" fill="#fff" textAnchor="middle">
                              {i + 1}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  )}
                  {busy && (
                    <div className="absolute inset-0 grid place-items-center bg-white/70">
                      <Loader2 className="h-8 w-8 animate-spin text-ember-orange" />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center p-6 text-center">
                  <div className="space-y-2">
                    <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white">
                      <Upload className="h-6 w-6 text-ember-orange" />
                    </div>
                    <p className="text-sm font-bold text-graphite">Upload one photo with several fruits or vegetables</p>
                    <p className="text-xs text-muted-foreground">Supported: JPG, PNG, WEBP</p>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <input type="file" accept="image/*" ref={fileRef} onChange={handleFile} className="hidden" data-testid="shelf-file-input" />
              <input type="file" accept="image/*" capture="environment" ref={cameraRef} onChange={handleFile} className="hidden" />
              <Button variant="secondary" className="w-full" disabled={busy || adding} onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Upload File
              </Button>
              <Button className="w-full" disabled={busy || adding} onClick={() => cameraRef.current?.click()}>
                <Camera className="h-4 w-4" /> Camera
              </Button>
            </div>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Photos are sent to the FreshGuard server for this mode. The finder is best with apples, bananas, oranges and carrots;
                other produce may be missed.
              </span>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-7">
        {busy && !rows ? (
          <Card className="flex min-h-[240px] items-center justify-center p-10">
            <div className="space-y-3 text-center" role="status">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-ember-orange" />
              <p className="text-sm font-bold text-graphite">Finding and inspecting items...</p>
            </div>
          </Card>
        ) : error ? (
          <Card data-testid="shelf-error">
            <CardContent className="space-y-4">
              <p className="flex items-start gap-2 font-bold text-graphite">
                <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-signal-red-orange" />
                {error.notInstalled ? "Whole-shelf scanning is not set up on this server." : "Could not scan this photo."}
              </p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
              <Button variant="secondary" onClick={onUseSingle}>
                Scan a single item instead
              </Button>
            </CardContent>
          </Card>
        ) : rows && rows.length > 0 ? (
          <Card data-testid="shelf-review">
            <CardHeader>
              <CardTitle>
                {meta && meta.items.length > 0
                  ? `${meta.items.length} item${meta.items.length === 1 ? "" : "s"} found`
                  : "No items found"}
              </CardTitle>
              <CardDescription>
                {checkCount > 0
                  ? `${checkCount} item${checkCount === 1 ? " needs" : "s need"} a check and ${checkCount === 1 ? "is" : "are"} unticked. Tick it if it is right, or change its type.`
                  : "Untick anything that is not food you want to track, or change its type."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {fewItems && (
                <div className="space-y-3 rounded-2xl bg-fog p-4 text-sm" data-testid="shelf-few-items">
                  <p className="text-graphite">
                    {meta!.items.length === 0
                      ? "No fruit or vegetables were recognised in this photo."
                      : "Only one item was recognised."}{" "}
                    The finder only knows apples, bananas, oranges and carrots as produce, so mangoes, peppers, potatoes, tomatoes, cucumbers
                    and strawberries are often missed. Items it found but the freshness model was not sure about, or that did not look
                    like fresh produce, are dropped
                    {meta!.rejected.length > 0 ? ` (${meta!.rejected.length} dropped here)` : ""}.
                  </p>
                  <Button variant="secondary" size="sm" onClick={onUseSingle}>
                    Scan a single item instead
                  </Button>
                </div>
              )}

              {notProduceCount > 0 && (
                <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="shelf-not-produce-note">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-sunset-orange" />
                  <span>
                    {notProduceCount} region{notProduceCount === 1 ? "" : "s"} did not look like fresh produce and{" "}
                    {notProduceCount === 1 ? "was" : "were"} skipped. A real item that is missing can be added with the single-item scan.
                  </span>
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-graphite" data-testid="shelf-selected-count">
                  {selectedCount} of {rows.length} selected
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRows(prev => prev ? prev.map(r => ({ ...r, selected: true })) : prev)}>
                    Select all
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRows(prev => prev ? prev.map(r => ({ ...r, selected: false })) : prev)}>
                    Clear
                  </Button>
                </div>
              </div>
                  <ul className="space-y-3">
                    {rows.map((r, i) => (
                      <li
                        key={`${r.image_url}-${i}`}
                        className="flex flex-wrap items-center gap-3 rounded-2xl border p-3"
                        data-testid={`shelf-item-${i}`}
                      >
                        <Checkbox
                          checked={r.selected}
                          onCheckedChange={v => update(i, { selected: v === true })}
                          aria-label={`Include item ${i + 1}`}
                          data-testid={`shelf-item-check-${i}`}
                        />
                        <img src={r.image_url} alt="" className="h-14 w-14 shrink-0 rounded-xl bg-fog object-cover" />
                        <div className="min-w-0 flex-1 basis-40 space-y-1">
                          <p className="truncate text-sm font-bold text-graphite">
                            {i + 1}. {displayName(r)}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusTag tone={tone(r.freshness_status)}>
                              {r.freshness_status[0].toUpperCase() + r.freshness_status.slice(1)}
                            </StatusTag>
                            <span className="text-xs text-muted-foreground">{r.confidence}% sure</span>
                            {r.needs_check && (
                              <span data-testid={`shelf-item-check-tag-${i}`}>
                                <StatusTag tone="caution">Check this item</StatusTag>
                              </span>
                            )}
                          </div>
                          {r.needs_check && r.check_reasons && r.check_reasons.length > 0 && (
                            <p className="text-xs text-muted-foreground" data-testid={`shelf-item-check-reason-${i}`}>
                              {r.check_reasons.map(c => CHECK_REASON_TEXT[c] ?? c).join(" ")}
                            </p>
                          )}
                        </div>
                        <div className="w-full sm:w-44">
                          <Select value={r.chosenFruit} onValueChange={v => update(i, { chosenFruit: v })}>
                            <SelectTrigger className="w-full" aria-label={`Type of item ${i + 1}`} data-testid={`shelf-item-type-${i}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(fruits.length > 0 ? fruits : [{ code: r.fruit, name_kr: r.fruit_kr } as FruitMeta]).map(f => (
                                <SelectItem key={f.code} value={f.code}>
                                  {f.name_kr}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="w-full"
                    disabled={selectedCount === 0 || adding}
                    onClick={addSelected}
                    data-testid="shelf-add-selected"
                  >
                    {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />}
                    Add selected to pantry ({selectedCount})
                  </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p className="font-bold text-graphite">How it works</p>
              <p>1. Upload or take one photo with several fruits or vegetables.</p>
              <p>2. Review the boxes and the list. Untick or change anything that is wrong.</p>
              <p>3. Add the ones you want to your Fridge Pantry.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
