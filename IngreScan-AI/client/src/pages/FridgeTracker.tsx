import DashboardLayout from "@/components/DashboardLayout";
import { PageHeader } from "@/components/brand/PageHeader";
import { StatusTag, type Tone } from "@/components/brand/StatusTag";
import { EthyleneAlerts } from "@/components/features/EthyleneAlerts";
import { RescueFridge } from "@/components/features/RescueFridge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { localExpiry, toLocalDateInput } from "@/lib/utils";
import {
  AlertTriangle,
  Apple,
  Barcode,
  Beef,
  CheckCircle2,
  Clock,
  Cookie,
  CupSoda,
  Egg,
  ExternalLink,
  Flame,
  IceCreamBowl,
  Milk,
  Package,
  Plus,
  Refrigerator,
  Search,
  Snowflake,
  Soup,
  Trash2,
  UtensilsCrossed,
  Wheat,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

const CATEGORIES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: "Dairy", label: "Dairy & Eggs", icon: Milk },
  { value: "Produce", label: "Fruits & Vegetables", icon: Apple },
  { value: "Meat", label: "Meat & Seafood", icon: Beef },
  { value: "Grains", label: "Bakery & Grains", icon: Wheat },
  { value: "Snacks", label: "Snacks & Packaged", icon: Cookie },
  { value: "Beverages", label: "Beverages", icon: CupSoda },
  { value: "Condiments", label: "Sauces & Condiments", icon: Soup },
  { value: "Other", label: "Other", icon: UtensilsCrossed },
];

const PRESETS: {
  title: string;
  category: string;
  storageLocation: string;
  days: number;
  icon: LucideIcon;
}[] = [
  { title: "Fresh Milk", category: "Dairy", storageLocation: "fridge", days: 5, icon: Milk },
  { title: "Whole Wheat Bread", category: "Grains", storageLocation: "pantry", days: 6, icon: Wheat },
  { title: "Greek Yogurt", category: "Dairy", storageLocation: "fridge", days: 12, icon: IceCreamBowl },
  { title: "Eggs (Dozen)", category: "Dairy", storageLocation: "fridge", days: 21, icon: Egg },
  { title: "Apples", category: "Produce", storageLocation: "fridge", days: 14, icon: Apple },
  { title: "Cheddar Cheese", category: "Dairy", storageLocation: "fridge", days: 25, icon: Milk },
];

const STORAGE: Record<string, { label: string; long: string; icon: LucideIcon }> = {
  fridge: { label: "Fridge", long: "Refrigerator", icon: Refrigerator },
  freezer: { label: "Freezer", long: "Deep Freezer", icon: Snowflake },
  pantry: { label: "Pantry", long: "Dry Pantry", icon: Package },
};

export default function FridgeTracker() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: items = [], isLoading } = trpc.inventory.list.useQuery();

  // The storage alerts and the rescue recipes are derived from the same pantry, so refresh them with the list.
  const refreshPantry = () => {
    void utils.inventory.list.invalidate();
    void utils.insights.ethyleneAlerts.invalidate();
  };

  const addMutation = trpc.inventory.add.useMutation({
    onSuccess: () => {
      refreshPantry();
      toast.success("Food item added to tracker!");
      setIsAddOpen(false);
      resetForm();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to add food item");
    },
  });

  const consumeMutation = trpc.inventory.consume.useMutation({
    onSuccess: () => {
      refreshPantry();
      toast.success("Marked as consumed! Zero food waste.");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update item");
    },
  });

  const deleteMutation = trpc.inventory.delete.useMutation({
    onSuccess: () => {
      refreshPantry();
      toast.success("Item removed from tracker");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to remove item");
    },
  });

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [activeLocation, setActiveLocation] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Form State
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Dairy");
  const [quantity, setQuantity] = useState("1");
  const [storageLocation, setStorageLocation] = useState<"fridge" | "freezer" | "pantry">("fridge");
  const [foodImageUrl, setFoodImageUrl] = useState("");
  const [barcode, setBarcode] = useState("");
  const [expiryDate, setExpiryDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return toLocalDateInput(d);
  });
  const [notes, setNotes] = useState("");

  const resetForm = () => {
    setTitle("");
    setCategory("Dairy");
    setQuantity("1");
    setStorageLocation("fridge");
    setFoodImageUrl("");
    setBarcode("");
    const d = new Date();
    d.setDate(d.getDate() + 7);
    setExpiryDate(toLocalDateInput(d));
    setNotes("");
  };

  const handleApplyPreset = (preset: typeof PRESETS[0]) => {
    setTitle(preset.title);
    setCategory(preset.category);
    setStorageLocation(preset.storageLocation as any);
    const d = new Date();
    d.setDate(d.getDate() + preset.days);
    setExpiryDate(toLocalDateInput(d));
  };

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Please enter a food title");
      return;
    }
    addMutation.mutate({
      title: title.trim(),
      category,
      quantity: quantity.trim() || "1",
      storageLocation,
      foodImageUrl: foodImageUrl.trim() || undefined,
      barcode: barcode.trim() || undefined,
      expiryDate,
      notes: notes.trim() || undefined,
    });
  };

  // Filtered Items
  const activeItems = useMemo(() => {
    return items
      .filter((item) => item.status !== "consumed")
      .map((item) => ({ ...item, ...localExpiry(item.expiryDate) }));
  }, [items]);

  const filteredItems = useMemo(() => {
    return activeItems.filter((item) => {
      const matchesLocation =
        activeLocation === "all" || item.storageLocation === activeLocation;
      const matchesCategory =
        selectedCategory.toLowerCase() === "all" ||
        (Boolean(item.category) && item.category.toLowerCase() === selectedCategory.toLowerCase());
      const matchesSearch =
        !searchQuery.trim() ||
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.notes && item.notes.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesLocation && matchesCategory && matchesSearch;
    });
  }, [activeItems, activeLocation, selectedCategory, searchQuery]);

  // Statistics
  const stats = useMemo(() => {
    const total = activeItems.length;
    const fresh = activeItems.filter((i) => i.status === "fresh").length;
    const expiringSoon = activeItems.filter((i) => i.status === "expiring_soon").length;
    const expired = activeItems.filter((i) => i.status === "expired").length;
    return { total, fresh, expiringSoon, expired };
  }, [activeItems]);

  const getCategoryIcon = (catName: string): LucideIcon => {
    const match = CATEGORIES.find((c) => c.value.toLowerCase() === catName.toLowerCase());
    return match ? match.icon : UtensilsCrossed;
  };

  const statTiles: {
    label: string;
    value: number;
    hint: string;
    icon: LucideIcon;
    iconClass: string;
    valueClass: string;
  }[] = [
    {
      label: "Total Tracked",
      value: stats.total,
      hint: "Active in your kitchen",
      icon: UtensilsCrossed,
      iconClass: "text-graphite",
      valueClass: "text-graphite",
    },
    {
      label: "Fresh & Good",
      value: stats.fresh,
      hint: "> 3 days of safe shelf life",
      icon: CheckCircle2,
      iconClass: "text-verdant-green",
      valueClass: "text-verdant-green",
    },
    {
      label: "Expiring Soon",
      value: stats.expiringSoon,
      hint: "Consume within 3 days!",
      icon: AlertTriangle,
      iconClass: "text-sunset-orange",
      valueClass: "text-sunset-orange",
    },
    {
      label: "Expired",
      value: stats.expired,
      hint: "Passed expiry date",
      icon: Flame,
      iconClass: "text-signal-red-orange",
      valueClass: "text-signal-red-orange",
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-8 md:space-y-10">
        <PageHeader
          eyebrow="Fridge & pantry"
          title="Food Expiry Tracker"
          description="Smart fridge & pantry management. Track expiry dates, eliminate food waste, and save money."
          actions={
            <>
              <Button variant="outline" asChild className="flex-1 sm:flex-none">
                <Link href="/openfoodfacts">
                  <Barcode className="h-4 w-4" />
                  Scan Barcode
                </Link>
              </Button>

              <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                <DialogTrigger asChild>
                  <Button className="flex-1 sm:flex-none">
                    <Plus className="h-4 w-4" />
                    Add Food Item
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
                  <form onSubmit={handleAddItem}>
                    <DialogHeader className="pr-8 text-left">
                      <DialogTitle className="flex items-center gap-3 text-xl font-bold">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog">
                          <Refrigerator className="h-5 w-5 text-ember-orange" />
                        </span>
                        Add Food to Tracker
                      </DialogTitle>
                      <DialogDescription>
                        Enter your item details or pick a quick preset below.
                      </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-5 py-6">
                      {/* Quick Presets */}
                      <div>
                        <Label className="text-xs font-bold text-muted-foreground">Quick Presets</Label>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {PRESETS.map((p) => {
                            const PresetIcon = p.icon;
                            return (
                              <Button
                                key={p.title}
                                type="button"
                                variant="secondary"
                                className="h-11 px-4 text-sm"
                                onClick={() => handleApplyPreset(p)}
                              >
                                <PresetIcon className="h-4 w-4 text-ember-orange" />
                                {p.title}
                              </Button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="item-title">Food Name *</Label>
                          <Input
                            id="item-title"
                            placeholder="e.g., Amul Pasteurized Butter"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="item-category">Category</Label>
                          <Select value={category} onValueChange={setCategory}>
                            <SelectTrigger id="item-category" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CATEGORIES.map((cat) => {
                                const CatIcon = cat.icon;
                                return (
                                  <SelectItem key={cat.value} value={cat.value}>
                                    <CatIcon className="h-4 w-4 text-muted-foreground" />
                                    {cat.label}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="item-storage">Storage Location</Label>
                          <Select
                            value={storageLocation}
                            onValueChange={(val: any) => setStorageLocation(val)}
                          >
                            <SelectTrigger id="item-storage" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(["fridge", "freezer", "pantry"] as const).map((loc) => {
                                const LocIcon = STORAGE[loc].icon;
                                return (
                                  <SelectItem key={loc} value={loc}>
                                    <LocIcon className="h-4 w-4 text-muted-foreground" />
                                    {STORAGE[loc].long}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="item-qty">Quantity</Label>
                          <Input
                            id="item-qty"
                            placeholder="e.g. 500g, 1 pack"
                            value={quantity}
                            onChange={(e) => setQuantity(e.target.value)}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="item-expiry">Expiry Date *</Label>
                          <Input
                            id="item-expiry"
                            type="date"
                            value={expiryDate}
                            onChange={(e) => setExpiryDate(e.target.value)}
                            required
                          />
                        </div>

                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="item-image">Image URL (Optional)</Label>
                          <Input
                            id="item-image"
                            placeholder="https://..."
                            value={foodImageUrl}
                            onChange={(e) => setFoodImageUrl(e.target.value)}
                          />
                        </div>

                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="item-notes">Notes / Brand</Label>
                          <Textarea
                            id="item-notes"
                            placeholder="e.g., Purchased from store, opened on Monday"
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsAddOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={addMutation.isPending}>
                        {addMutation.isPending ? "Adding..." : "Save to Tracker"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          }
        />

        {/* Stats Row */}
        <section aria-label="Tracker summary" className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
          {statTiles.map((t) => {
            const TileIcon = t.icon;
            return (
              <div key={t.label} className="flex min-w-0 flex-col gap-4 rounded-3xl bg-white p-4 sm:p-6">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-graphite">{t.label}</p>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-fog">
                    <TileIcon className={`h-[18px] w-[18px] ${t.iconClass}`} />
                  </span>
                </div>
                <div>
                  <p className={`fn-metric text-4xl md:text-5xl ${t.valueClass}`}>{t.value}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{t.hint}</p>
                </div>
              </div>
            );
          })}
        </section>

        <RescueFridge />
        <EthyleneAlerts />

        {/* Filter & Search Bar */}
        <div className="flex flex-col gap-3 rounded-3xl bg-white p-3 sm:p-4 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            value={activeLocation}
            onValueChange={setActiveLocation}
            className="w-full lg:w-auto"
          >
            <TabsList className="grid w-full grid-cols-4 lg:w-auto">
              <TabsTrigger value="all" aria-controls={undefined} className="px-1.5 text-[13px] sm:px-3 sm:text-sm">
                All Storage
              </TabsTrigger>
              <TabsTrigger value="fridge" aria-controls={undefined} className="px-1.5 text-[13px] sm:px-3 sm:text-sm">
                <Refrigerator className="hidden h-4 w-4 sm:block" /> Fridge
              </TabsTrigger>
              <TabsTrigger value="freezer" aria-controls={undefined} className="px-1.5 text-[13px] sm:px-3 sm:text-sm">
                <Snowflake className="hidden h-4 w-4 sm:block" /> Freezer
              </TabsTrigger>
              <TabsTrigger value="pantry" aria-controls={undefined} className="px-1.5 text-[13px] sm:px-3 sm:text-sm">
                <Package className="hidden h-4 w-4 sm:block" /> Pantry
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:flex-1 lg:w-64 lg:flex-none">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search food item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
                aria-label="Search food item"
              />
            </div>

            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="w-full sm:w-[210px]" aria-label="Filter by category">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {CATEGORIES.map((cat) => {
                  const CatIcon = cat.icon;
                  return (
                    <SelectItem key={cat.value} value={cat.value}>
                      <CatIcon className="h-4 w-4 text-muted-foreground" />
                      {cat.label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Food Items List */}
        {isLoading ? (
          <div role="status" className="rounded-3xl bg-white py-16 text-center text-muted-foreground">
            Loading food inventory...
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center rounded-3xl bg-white px-5 py-14 text-center sm:py-16">
            <span className="grid h-14 w-14 place-items-center rounded-3xl bg-fog">
              <Refrigerator className="h-7 w-7 text-ember-orange" />
            </span>
            <h3 className="fn-heading-sm mt-5 text-graphite">No food items found</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {searchQuery || selectedCategory !== "all" || activeLocation !== "all"
                ? "Try clearing your filters or search query to see your items."
                : "Your tracker is empty! Start logging items to track freshness and receive expiration alerts."}
            </p>
            <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:w-auto sm:flex-row">
              <Button onClick={() => setIsAddOpen(true)}>
                <Plus className="h-4 w-4" /> Add Food Item
              </Button>
              <Button variant="outline" asChild>
                <Link href="/openfoodfacts">
                  <Barcode className="h-4 w-4" /> Lookup Barcode
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
            {filteredItems.map((item: any) => {
              const daysLeft = item.daysLeft ?? 0;
              const isExpired = item.status === "expired" || daysLeft < 0;
              const isExpiringSoon = !isExpired && (item.status === "expiring_soon" || daysLeft <= 3);
              const tone: Tone = isExpired ? "negative" : isExpiringSoon ? "caution" : "positive";
              const statusLabel = isExpired ? "Expired" : isExpiringSoon ? "Expiring soon" : "Fresh";
              const clockClass = isExpired
                ? "text-signal-red-orange"
                : isExpiringSoon
                ? "text-sunset-orange"
                : "text-verdant-green";
              const storage = STORAGE[item.storageLocation] ?? STORAGE.pantry;
              const StorageIcon = storage.icon;
              const CategoryIcon = getCategoryIcon(item.category);

              return (
                <article
                  key={item.id}
                  className="flex min-w-0 flex-col rounded-3xl border border-border bg-white"
                >
                  <div className="flex items-start gap-4 p-5 pb-4">
                    {item.foodImageUrl ? (
                      <img
                        src={item.foodImageUrl}
                        alt={item.title}
                        className="h-14 w-14 shrink-0 rounded-2xl bg-fog object-cover"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-fog">
                        <CategoryIcon className="h-6 w-6 text-ember-orange" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="line-clamp-1 text-base font-bold text-graphite">
                          {item.title}
                        </h3>
                        <StatusTag tone={tone} className="shrink-0">
                          {statusLabel}
                        </StatusTag>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-bold text-graphite">{item.category}</span>
                        <span>Qty: {item.quantity}</span>
                        <span className="inline-flex items-center gap-1">
                          <StorageIcon className="h-3.5 w-3.5" />
                          {storage.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 px-5 pb-4">
                    {/* Expiry Countdown */}
                    <div className="flex items-center justify-between gap-3 rounded-2xl bg-fog px-4 py-3 text-sm">
                      <span className="flex items-center gap-2 font-bold text-graphite">
                        <Clock className={`h-4 w-4 shrink-0 ${clockClass}`} />
                        {daysLeft === 0
                          ? "Expires Today!"
                          : isExpired
                          ? `Expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago`
                          : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(item.expiryDate).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        })}
                      </span>
                    </div>

                    {item.notes && (
                      <p className="line-clamp-2 text-xs italic text-muted-foreground">
                        &ldquo;{item.notes}&rdquo;
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                    <Button
                      variant="ghost"
                      className="px-3"
                      disabled={consumeMutation.isPending || deleteMutation.isPending}
                      onClick={() => consumeMutation.mutate({ id: item.id })}
                    >
                      <CheckCircle2 className="h-4 w-4 text-verdant-green" />
                      Consumed
                    </Button>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        className="px-3 text-muted-foreground hover:text-graphite"
                        onClick={() => {
                          setLocation(`/scanner?prefill=${encodeURIComponent(item.title)}`);
                        }}
                      >
                        Scan <ExternalLink className="h-3.5 w-3.5" />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${item.title}`}
                        className="text-signal-red-orange"
                        disabled={consumeMutation.isPending || deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate({ id: item.id })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
