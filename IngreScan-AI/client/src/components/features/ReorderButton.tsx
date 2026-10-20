import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildItemReorderLinks,
  buildBatchReorderLinks,
  buildBlinkitUrl,
  buildZeptoUrl,
  ReorderItem,
} from "@shared/engines";
import { ShoppingBag, Zap, Store, Truck, MessageCircle, ExternalLink, ChevronDown } from "lucide-react";
import { toast } from "sonner";

interface ReorderButtonProps {
  item: string | ReorderItem;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  showDropdown?: boolean;
}

export function ReorderButton({
  item,
  variant = "outline",
  size = "sm",
  className = "",
  showDropdown = true,
}: ReorderButtonProps) {
  const name = typeof item === "string" ? item : item.name;
  const links = buildItemReorderLinks(item);
  const primaryBlinkit = links.find((l) => l.provider === "blinkit");
  const primaryZepto = links.find((l) => l.provider === "zepto");

  const openProvider = (url: string, providerName: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
    toast.success(`Opening ${providerName} for "${name}"`);
  };

  if (!showDropdown) {
    return (
      <Button
        variant={variant}
        size={size}
        className={`gap-1.5 font-bold ${className}`}
        onClick={() => openProvider(primaryBlinkit?.url || buildBlinkitUrl(name), "Blinkit")}
      >
        <Zap className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
        Order (10m)
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className={`gap-1 font-bold ${className}`}>
          <ShoppingBag className="h-3.5 w-3.5 text-ember-orange" />
          <span>Restock</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 rounded-2xl p-1.5 shadow-xl">
        <DropdownMenuLabel className="px-2.5 py-1 text-xs font-bold text-muted-foreground">
          Quick-Commerce Restock
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Blinkit */}
        <DropdownMenuItem
          className="flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 font-medium cursor-pointer hover:bg-fog"
          onClick={() => openProvider(primaryBlinkit?.url || buildBlinkitUrl(name), "Blinkit")}
        >
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-amber-100 text-amber-700">
              <Zap className="h-3.5 w-3.5 fill-amber-500 text-amber-600" />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-graphite">Blinkit</span>
              <span className="text-[10px] text-muted-foreground">10-minute delivery</span>
            </div>
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuItem>

        {/* Zepto */}
        <DropdownMenuItem
          className="flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 font-medium cursor-pointer hover:bg-fog"
          onClick={() => openProvider(primaryZepto?.url || buildZeptoUrl(name), "Zepto")}
        >
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-purple-100 text-purple-700">
              <ShoppingBag className="h-3.5 w-3.5 text-purple-600" />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-graphite">Zepto</span>
              <span className="text-[10px] text-muted-foreground">10-minute delivery</span>
            </div>
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuItem>

        {/* Instacart */}
        <DropdownMenuItem
          className="flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 font-medium cursor-pointer hover:bg-fog"
          onClick={() => {
            const l = links.find((x) => x.provider === "instacart");
            if (l) openProvider(l.url, "Instacart");
          }}
        >
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
              <Store className="h-3.5 w-3.5 text-emerald-600" />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-graphite">Instacart</span>
              <span className="text-[10px] text-muted-foreground">Same-day delivery</span>
            </div>
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuItem>

        {/* Amazon Fresh */}
        <DropdownMenuItem
          className="flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 font-medium cursor-pointer hover:bg-fog"
          onClick={() => {
            const l = links.find((x) => x.provider === "amazon_fresh");
            if (l) openProvider(l.url, "Amazon Fresh");
          }}
        >
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-blue-100 text-blue-700">
              <Truck className="h-3.5 w-3.5 text-blue-600" />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-graphite">Amazon Fresh</span>
              <span className="text-[10px] text-muted-foreground">Scheduled delivery</span>
            </div>
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface BatchReorderProps {
  items: Array<string | ReorderItem>;
  title?: string;
  className?: string;
}

export function RecipeReorderCard({ items, title = "Order Missing Ingredients", className = "" }: BatchReorderProps) {
  if (items.length === 0) return null;

  const links = buildBatchReorderLinks(items);
  const primaryName = typeof items[0] === "string" ? items[0] : items[0].name;

  return (
    <div className={`rounded-2xl border border-amber-500/20 bg-amber-500/5 p-3.5 ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500 fill-amber-500" />
          <span className="text-xs font-bold text-graphite">{title}</span>
        </div>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
          {items.length} item{items.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground mb-3">
        {items.map((it, i) => {
          const name = typeof it === "string" ? it : it.name;
          return (
            <span key={i} className="rounded-md bg-white border border-border px-1.5 py-0.5 font-medium text-graphite">
              {name}
            </span>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {/* Blinkit Button */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 justify-start gap-1.5 bg-white text-xs font-bold hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300"
          onClick={() => {
            window.open(buildBlinkitUrl(primaryName), "_blank", "noopener,noreferrer");
            toast.success(`Opening Blinkit for ${primaryName}`);
          }}
        >
          <Zap className="h-3 w-3 fill-amber-500 text-amber-600 shrink-0" />
          <span className="truncate">Blinkit</span>
        </Button>

        {/* Zepto Button */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 justify-start gap-1.5 bg-white text-xs font-bold hover:bg-purple-50 hover:text-purple-700 hover:border-purple-300"
          onClick={() => {
            window.open(buildZeptoUrl(primaryName), "_blank", "noopener,noreferrer");
            toast.success(`Opening Zepto for ${primaryName}`);
          }}
        >
          <ShoppingBag className="h-3 w-3 text-purple-600 shrink-0" />
          <span className="truncate">Zepto</span>
        </Button>

        {/* WhatsApp Export */}
        <Button
          variant="outline"
          size="sm"
          className="col-span-2 sm:col-span-1 h-8 justify-start gap-1.5 bg-white text-xs font-bold hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300"
          onClick={() => {
            const wa = links.find((l) => l.provider === "whatsapp");
            if (wa) {
              window.open(wa.url, "_blank", "noopener,noreferrer");
              toast.success("Generated WhatsApp shopping checklist");
            }
          }}
        >
          <MessageCircle className="h-3 w-3 text-emerald-600 shrink-0" />
          <span className="truncate">WhatsApp List</span>
        </Button>
      </div>
    </div>
  );
}
