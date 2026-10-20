import { ReorderButton } from "@/components/features/ReorderButton";
import { HouseholdManager, HouseholdBanner } from "@/components/features/HouseholdManager";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { localExpiry, toLocalDateInput } from "@/lib/utils";
import {
  AlertTriangle,
  Apple,
  ArrowUpDown,
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
  LayoutGrid,
  Leaf,
  List,
  Milk,
  Package,
  Plus,
  Refrigerator,
  Search,
  Snowflake,
  Soup,
  Sparkles,
  Trash2,
  Users,
  UtensilsCrossed,
  Wheat,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

export type UnifiedPantryItem = {
  compositeId: string;
  rawId: number;
  kind: "produce" | "packaged";
  userId?: number;
  title: string;
  category: string;
  quantity: string;
  storageLocation: "fridge" | "freezer" | "pantry";
  imageUrl: string | null;
  barcode: string | null;
  expiryDate: string;
  daysLeft: number;
  status: "fresh" | "expiring_soon" | "expired" | "consumed";
  notes?: string | null;
  produceDetails?: {
    fruitType: string;
    freshness: "fresh" | "normal" | "rotten";
    pFresh: number;
    confidence: number;
    storageTip?: string;
  };
  createdAt?: string | Date;
};

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

  // Unified data sources: Packaged Groceries + FreshGuard Produce AI Inventory
  const { data: packagedItems = [], isLoading: isLoadingPackaged } = trpc.inventory.list.useQuery();
  const { data: produceItems = [], isLoading: isLoadingProduce } = trpc.produce.listInventory.useQuery();
  const { data: householdData } = trpc.household.get.useQuery();

  const isLoading = isLoadingPackaged || isLoadingProduce;

  // Refresh both inventories and storage intelligence alerts
  const refreshPantry = () => {
    void utils.inventory.list.invalidate();
    void utils.produce.listInventory.invalidate();
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

  const deleteProduceMutation = trpc.produce.deleteInventory.useMutation({
    onSuccess: () => {
      refreshPantry();
      toast.success("Produce item removed / consumed!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to remove produce item");
    },
  });

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [activeLocation, setActiveLocation] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedKind, setSelectedKind] = useState<"all" | "produce" | "packaged">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [sortBy, setSortBy] = useState<"expiry" | "name" | "status" | "category">("expiry");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

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

  // Cross-Pantry Merge: Unify packaged groceries and fresh produce
  const unifiedItems: UnifiedPantryItem[] = useMemo(() => {
    const list: UnifiedPantryItem[] = [];

    // 1. Packaged groceries
    for (const item of packagedItems) {
      if (item.status === "consumed") continue;
      const { daysLeft, status } = localExpiry(item.expiryDate);
      list.push({
        compositeId: `packaged:${item.id}`,
        rawId: item.id,
        kind: "packaged",
        userId: item.userId,
        title: item.title,
        category: item.category || "Other",
        quantity: item.quantity || "1",
        storageLocation: (item.storageLocation as any) || "fridge",
        imageUrl: item.foodImageUrl || null,
        barcode: item.barcode || null,
        expiryDate:
          item.expiryDate instanceof Date
            ? item.expiryDate.toISOString().slice(0, 10)
            : String(item.expiryDate).slice(0, 10),
        daysLeft,
        status,
        notes: item.notes || null,
        createdAt: item.createdAt,
      });
    }

    // 2. Fresh produce from FreshGuard AI
    for (const item of produceItems) {
      const daysLeft = item.days_left ?? 0;
      const isExpired = item.freshness === "rotten" || daysLeft < 0;
      const isExpiringSoon = !isExpired && daysLeft <= 3;
      const status: "fresh" | "expiring_soon" | "expired" = isExpired
        ? "expired"
        : isExpiringSoon
        ? "expiring_soon"
        : "fresh";

      list.push({
        compositeId: `produce:${item.id}`,
        rawId: item.id,
        kind: "produce",
        title: item.name || item.fruit_type,
        category: "Produce",
        quantity: "Fresh batch",
        storageLocation: "fridge",
        imageUrl: item.image_url || null,
        barcode: null,
        expiryDate: item.expiry_date,
        daysLeft,
        status,
        notes: item.storage_tip || null,
        produceDetails: {
          fruitType: item.fruit_type,
          freshness: item.freshness,
          pFresh: item.p_fresh,
          confidence: item.confidence,
          storageTip: item.storage_tip,
        },
        createdAt: item.created_at,
      });
    }

    return list;
  }, [packagedItems, produceItems]);

  // Filtered & Sorted Items
  const filteredItems = useMemo(() => {
    const filtered = unifiedItems.filter((item) => {
      const matchesKind = selectedKind === "all" || item.kind === selectedKind;
      const matchesLocation =
        activeLocation === "all" || item.storageLocation === activeLocation;
      const matchesCategory =
        selectedCategory.toLowerCase() === "all" ||
        (Boolean(item.category) && item.category.toLowerCase() === selectedCategory.toLowerCase());
      const matchesSearch =
        !searchQuery.trim() ||
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.notes && item.notes.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (item.produceDetails?.fruitType &&
          item.produceDetails.fruitType.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesKind && matchesLocation && matchesCategory && matchesSearch;
    });

    return filtered.sort((a, b) => {
      if (sortBy === "expiry") {
        return sortDir === "asc" ? a.daysLeft - b.daysLeft : b.daysLeft - a.daysLeft;
      }
      if (sortBy === "name") {
        return sortDir === "asc" ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title);
      }
      if (sortBy === "category") {
        return sortDir === "asc"
          ? a.category.localeCompare(b.category)
          : b.category.localeCompare(a.category);
      }
      if (sortBy === "status") {
        const order = { expired: 0, expiring_soon: 1, fresh: 2, consumed: 3 };
        return sortDir === "asc"
          ? order[a.status] - order[b.status]
          : order[b.status] - order[a.status];
      }
      return 0;
    });
  }, [unifiedItems, selectedKind, activeLocation, selectedCategory, searchQuery, sortBy, sortDir]);

  // Statistics
  const stats = useMemo(() => {
    const total = unifiedItems.length;
    const fresh = unifiedItems.filter((i) => i.status === "fresh").length;
    const expiringSoon = unifiedItems.filter((i) => i.status === "expiring_soon").length;
    const expired = unifiedItems.filter((i) => i.status === "expired").length;
    const produceCount = unifiedItems.filter((i) => i.kind === "produce").length;
    const packagedCount = unifiedItems.filter((i) => i.kind === "packaged").length;
    return { total, fresh, expiringSoon, expired, produceCount, packagedCount };
  }, [unifiedItems]);

  const toggleSort = (col: "expiry" | "name" | "status" | "category") => {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("asc");
    }
  };

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
      label: "Total Inventory",
      value: stats.total,
      hint: `${stats.produceCount} fresh produce • ${stats.packagedCount} packaged`,
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
          eyebrow="Unified kitchen & pantry"
          title="Food Expiry Tracker"
          description="Cross-pantry inventory management. Fresh produce and packaged groceries live-synced in one unified hub."
          actions={
            <>
              <HouseholdManager />

              <Button variant="outline" asChild className="flex-1 sm:flex-none">
                <Link href="/produce">
                  <Leaf className="h-4 w-4 text-verdant-green" />
                  Scan Produce AI
                </Link>
              </Button>

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
                          <Label htmlFor="item-quantity">Quantity</Label>
                          <Input
                            id="item-quantity"
                            placeholder="e.g., 500g, 2 packets"
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
                          <Label htmlFor="item-barcode">Barcode (Optional)</Label>
                          <Input
                            id="item-barcode"
                            placeholder="Scan or type product barcode"
                            value={barcode}
                            onChange={(e) => setBarcode(e.target.value)}
                          />
                        </div>

                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="item-image">Image URL (Optional)</Label>
                          <Input
                            id="item-image"
                            placeholder="Paste product image URL"
                            value={foodImageUrl}
                            onChange={(e) => setFoodImageUrl(e.target.value)}
                          />
                        </div>

                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="item-notes">Notes (Optional)</Label>
                          <Textarea
                            id="item-notes"
                            placeholder="e.g., Opened on Tuesday, keep sealed"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={2}
                          />
                        </div>
                      </div>
                    </div>

                    <DialogFooter className="border-t border-fog pt-4">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setIsAddOpen(false);
                          resetForm();
                        }}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={addMutation.isPending}>
                        {addMutation.isPending ? "Adding..." : "Add to Tracker"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          }
        />

        <HouseholdBanner />

        {/* Stats Grid */}
        <section aria-label="Inventory summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {statTiles.map((t) => {
            const Icon = t.icon;
            return (
              <div
                key={t.label}
                className="flex flex-col justify-between rounded-3xl border border-border bg-white p-5 md:p-6"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    {t.label}
                  </span>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-fog">
                    <Icon className={`h-5 w-5 ${t.iconClass}`} />
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

        {/* Filter & View Switcher Bar */}
        <div className="flex flex-col gap-3 rounded-3xl bg-white p-3 sm:p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {/* Storage Location Tabs */}
            <Tabs
              value={activeLocation}
              onValueChange={setActiveLocation}
              className="w-full sm:w-auto"
            >
              <TabsList className="grid w-full grid-cols-4 sm:w-auto">
                <TabsTrigger value="all" className="px-2 text-xs sm:px-3 sm:text-sm">
                  All Storage
                </TabsTrigger>
                <TabsTrigger value="fridge" className="px-2 text-xs sm:px-3 sm:text-sm">
                  <Refrigerator className="hidden h-4 w-4 sm:block" /> Fridge
                </TabsTrigger>
                <TabsTrigger value="freezer" className="px-2 text-xs sm:px-3 sm:text-sm">
                  <Snowflake className="hidden h-4 w-4 sm:block" /> Freezer
                </TabsTrigger>
                <TabsTrigger value="pantry" className="px-2 text-xs sm:px-3 sm:text-sm">
                  <Package className="hidden h-4 w-4 sm:block" /> Pantry
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Pantry Kind Filter (Unified cross-pantry) */}
            <Select value={selectedKind} onValueChange={(v: any) => setSelectedKind(v)}>
              <SelectTrigger className="w-full sm:w-[170px]" aria-label="Filter by pantry source">
                <SelectValue placeholder="All Items" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  All ({stats.total})
                </SelectItem>
                <SelectItem value="produce">
                  <div className="flex items-center gap-1.5">
                    <Leaf className="h-3.5 w-3.5 text-verdant-green" />
                    Produce ({stats.produceCount})
                  </div>
                </SelectItem>
                <SelectItem value="packaged">
                  <div className="flex items-center gap-1.5">
                    <Package className="h-3.5 w-3.5 text-graphite" />
                    Packaged ({stats.packagedCount})
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* Search Input */}
            <div className="relative w-full sm:flex-1 lg:w-60 lg:flex-none">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search food or produce..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9.5 text-sm"
                aria-label="Search food item"
              />
            </div>

            {/* Category Select */}
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by category">
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

            {/* View Mode Switcher (Table vs Grid) */}
            <div className="flex items-center rounded-xl bg-fog p-1 border border-border shrink-0 self-end sm:self-auto">
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all ${
                  viewMode === "table"
                    ? "bg-white text-graphite shadow-xs"
                    : "text-muted-foreground hover:text-graphite"
                }`}
                title="Unified Table View"
              >
                <List className="h-4 w-4" />
                <span className="hidden sm:inline">Table</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all ${
                  viewMode === "grid"
                    ? "bg-white text-graphite shadow-xs"
                    : "text-muted-foreground hover:text-graphite"
                }`}
                title="Card Grid View"
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="hidden sm:inline">Cards</span>
              </button>
            </div>
          </div>
        </div>

        {/* Food Items Display */}
        {isLoading ? (
          <div role="status" className="rounded-3xl bg-white py-16 text-center text-muted-foreground">
            Loading unified food & produce inventory...
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center rounded-3xl bg-white px-5 py-14 text-center sm:py-16">
            <span className="grid h-14 w-14 place-items-center rounded-3xl bg-fog">
              <Refrigerator className="h-7 w-7 text-ember-orange" />
            </span>
            <h3 className="fn-heading-sm mt-5 text-graphite">No food items found</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {searchQuery || selectedCategory !== "all" || activeLocation !== "all" || selectedKind !== "all"
                ? "Try clearing your filters or search query to see your items."
                : "Your tracker is empty! Start logging items to track freshness and receive expiration alerts."}
            </p>
            <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:w-auto sm:flex-row">
              <Button onClick={() => setIsAddOpen(true)}>
                <Plus className="h-4 w-4" /> Add Food Item
              </Button>
              <Button variant="outline" asChild>
                <Link href="/produce">
                  <Leaf className="h-4 w-4 text-verdant-green" /> Scan Produce AI
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/openfoodfacts">
                  <Barcode className="h-4 w-4" /> Lookup Barcode
                </Link>
              </Button>
            </div>
          </div>
        ) : viewMode === "table" ? (
          /* ================= UNIFIED INVENTORY TABLE ================= */
          <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-xs">
            <Table>
              <TableHeader>
                <TableRow className="bg-fog/60 hover:bg-fog/60 border-b border-border">
                  <TableHead
                    onClick={() => toggleSort("name")}
                    className="w-[280px] sm:w-[320px] font-bold text-graphite cursor-pointer select-none"
                  >
                    <span className="flex items-center gap-1.5">
                      Food Item
                      <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  </TableHead>
                  <TableHead
                    onClick={() => toggleSort("category")}
                    className="font-bold text-graphite cursor-pointer select-none"
                  >
                    <span className="flex items-center gap-1.5">
                      Type & Category
                      <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  </TableHead>
                  <TableHead className="font-bold text-graphite">Storage</TableHead>
                  <TableHead
                    onClick={() => toggleSort("expiry")}
                    className="font-bold text-graphite cursor-pointer select-none"
                  >
                    <span className="flex items-center gap-1.5">
                      Freshness & Expiry
                      <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  </TableHead>
                  <TableHead className="font-bold text-graphite">Quantity</TableHead>
                  <TableHead className="text-right font-bold text-graphite">Actions & Restock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => {
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

                  const isProduce = item.kind === "produce";

                  const handleConsume = () => {
                    if (isProduce) {
                      deleteProduceMutation.mutate({ id: item.rawId });
                    } else {
                      consumeMutation.mutate({ id: item.rawId });
                    }
                  };

                  const handleDelete = () => {
                    if (isProduce) {
                      deleteProduceMutation.mutate({ id: item.rawId });
                    } else {
                      deleteMutation.mutate({ id: item.rawId });
                    }
                  };

                  return (
                    <TableRow key={item.compositeId} className="hover:bg-fog/40 transition-colors">
                      {/* Column 1: Food Item */}
                      <TableCell className="py-3">
                        <div className="flex items-center gap-3">
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.title}
                              className="h-10 w-10 shrink-0 rounded-xl bg-fog object-cover"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-fog">
                              {isProduce ? (
                                <Apple className="h-5 w-5 text-verdant-green" />
                              ) : (
                                <CategoryIcon className="h-5 w-5 text-ember-orange" />
                              )}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-sm text-graphite truncate max-w-[200px]">
                                {item.title}
                              </span>
                              {householdData?.household && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-verdant-green bg-verdant-green/10 px-1.5 py-0.5 rounded-md">
                                  <Users className="h-2.5 w-2.5" /> Shared
                                </span>
                              )}
                            </div>
                            {isProduce && item.produceDetails ? (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                                <Sparkles className="h-3 w-3 text-ember-orange" />
                                <span>FreshGuard AI: {Math.round(item.produceDetails.pFresh)}% fresh</span>
                              </p>
                            ) : item.notes ? (
                              <p className="text-xs text-muted-foreground truncate max-w-[220px]">
                                {item.notes}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>

                      {/* Column 2: Type & Category */}
                      <TableCell className="py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                              isProduce
                                ? "bg-verdant-green/15 text-verdant-green"
                                : "bg-fog text-graphite"
                            }`}
                          >
                            {isProduce ? (
                              <Leaf className="h-3 w-3" />
                            ) : (
                              <Package className="h-3 w-3" />
                            )}
                            {isProduce ? "Produce" : "Packaged"}
                          </span>
                          <span className="text-xs text-muted-foreground hidden sm:inline">
                            {item.category}
                          </span>
                        </div>
                      </TableCell>

                      {/* Column 3: Storage */}
                      <TableCell className="py-3">
                        <div className="flex items-center gap-1.5 text-xs text-graphite font-medium">
                          <StorageIcon className="h-4 w-4 text-muted-foreground" />
                          <span>{storage.label}</span>
                        </div>
                      </TableCell>

                      {/* Column 4: Freshness & Expiry */}
                      <TableCell className="py-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <StatusTag tone={tone} className="text-xs">
                              {statusLabel}
                            </StatusTag>
                            <span className={`text-xs font-bold ${clockClass} flex items-center gap-1`}>
                              <Clock className="h-3 w-3" />
                              {daysLeft === 0
                                ? "Today!"
                                : isExpired
                                ? `${Math.abs(daysLeft)}d ago`
                                : `${daysLeft}d left`}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {new Date(item.expiryDate).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              timeZone: "UTC",
                            })}
                          </p>
                        </div>
                      </TableCell>

                      {/* Column 5: Quantity */}
                      <TableCell className="py-3 text-xs text-graphite">
                        {item.quantity}
                      </TableCell>

                      {/* Column 6: Actions & Restock */}
                      <TableCell className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs font-semibold text-verdant-green hover:bg-verdant-green/10"
                            onClick={handleConsume}
                            title="Mark as consumed"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                            Consumed
                          </Button>

                          {/* 1-Click Pantry-to-Cart Quick Commerce */}
                          <ReorderButton item={item.title} size="sm" variant="ghost" />

                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs text-muted-foreground hover:text-graphite"
                            onClick={() => {
                              if (isProduce) {
                                setLocation("/produce");
                              } else {
                                setLocation(`/scanner?prefill=${encodeURIComponent(item.title)}`);
                              }
                            }}
                            title={isProduce ? "Inspect with FreshGuard AI" : "Scan nutrition label"}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-signal-red-orange hover:bg-signal-red-orange/10"
                            onClick={handleDelete}
                            title="Delete item"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          /* ================= UNIFIED CARD GRID VIEW ================= */
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
            {filteredItems.map((item) => {
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

              const isProduce = item.kind === "produce";

              const handleConsume = () => {
                if (isProduce) {
                  deleteProduceMutation.mutate({ id: item.rawId });
                } else {
                  consumeMutation.mutate({ id: item.rawId });
                }
              };

              const handleDelete = () => {
                if (isProduce) {
                  deleteProduceMutation.mutate({ id: item.rawId });
                } else {
                  deleteMutation.mutate({ id: item.rawId });
                }
              };

              return (
                <article
                  key={item.compositeId}
                  className="flex min-w-0 flex-col rounded-3xl border border-border bg-white"
                >
                  <div className="flex items-start gap-4 p-5 pb-4">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.title}
                        className="h-14 w-14 shrink-0 rounded-2xl bg-fog object-cover"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-fog">
                        {isProduce ? (
                          <Apple className="h-6 w-6 text-verdant-green" />
                        ) : (
                          <CategoryIcon className="h-6 w-6 text-ember-orange" />
                        )}
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
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            isProduce
                              ? "bg-verdant-green/15 text-verdant-green"
                              : "bg-fog text-graphite"
                          }`}
                        >
                          {isProduce ? <Leaf className="h-3 w-3" /> : <Package className="h-3 w-3" />}
                          {isProduce ? "Produce" : "Packaged"}
                        </span>
                        <span>{item.category}</span>
                        <span>Qty: {item.quantity}</span>
                        <span className="inline-flex items-center gap-1">
                          <StorageIcon className="h-3.5 w-3.5" />
                          {storage.label}
                        </span>
                        {householdData?.household && (
                          <span className="inline-flex items-center gap-1 text-verdant-green font-semibold">
                            <Users className="h-3 w-3" />
                            Shared
                          </span>
                        )}
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

                    {isProduce && item.produceDetails ? (
                      <p className="flex items-center gap-1 text-xs text-verdant-green font-semibold">
                        <Sparkles className="h-3.5 w-3.5 text-ember-orange" />
                        FreshGuard AI: {Math.round(item.produceDetails.pFresh)}% freshness score
                      </p>
                    ) : item.notes ? (
                      <p className="line-clamp-2 text-xs italic text-muted-foreground">
                        &ldquo;{item.notes}&rdquo;
                      </p>
                    ) : null}
                  </div>

                  {/* Actions */}
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        className="px-3"
                        disabled={consumeMutation.isPending || deleteMutation.isPending}
                        onClick={handleConsume}
                      >
                        <CheckCircle2 className="h-4 w-4 text-verdant-green" />
                        Consumed
                      </Button>

                      {/* 1-Click Pantry-to-Cart Quick Commerce Restock */}
                      <ReorderButton item={item.title} size="sm" variant="ghost" />
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        className="px-3 text-muted-foreground hover:text-graphite"
                        onClick={() => {
                          if (isProduce) {
                            setLocation("/produce");
                          } else {
                            setLocation(`/scanner?prefill=${encodeURIComponent(item.title)}`);
                          }
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
                        onClick={handleDelete}
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
