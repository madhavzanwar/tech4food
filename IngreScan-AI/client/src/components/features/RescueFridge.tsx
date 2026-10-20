import { StatusTag } from "@/components/brand/StatusTag";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { ChefHat, Clock, Loader2, ShieldAlert, Users } from "lucide-react";
import { RecipeReorderCard, ReorderButton } from "@/components/features/ReorderButton";

const SOURCE_LABEL = { llm: "AI", offline: "Offline template" } as const;

/** "Rescue my fridge": quick recipes from items that expire within 3 days. */
export function RescueFridge({ className = "" }: { className?: string }) {
  const rescue = trpc.rescue.recipes.useMutation();
  const data = rescue.data;

  const run = () => rescue.mutate({ windowDays: 3, utcOffsetMinutes: -new Date().getTimezoneOffset() });

  return (
    <section className={`space-y-5 rounded-3xl bg-white p-5 md:p-7 ${className}`} aria-label="Rescue my fridge">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
            <ChefHat className="h-5 w-5 text-ember-orange" />
          </span>
          <div className="min-w-0">
            <h2 className="fn-heading-sm text-graphite">Rescue my fridge</h2>
            <p className="text-sm text-muted-foreground">
              Get quick recipes (15 minutes or less) from food that expires within 3 days.
            </p>
          </div>
        </div>
        <Button onClick={run} disabled={rescue.isPending} className="w-full shrink-0 sm:w-auto">
          {rescue.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChefHat className="h-4 w-4" />}
          {rescue.isPending ? "Finding recipes..." : data ? "Refresh recipes" : "Rescue my fridge"}
        </Button>
      </div>

      {rescue.error && <p role="alert" className="text-sm text-signal-red-orange">{rescue.error.message}</p>}

      {data && data.selection.urgent.length === 0 && (
        <p className="rounded-2xl bg-fog p-4 text-sm font-medium text-graphite">
          Nothing expires within 3 days, so there is nothing to rescue right now.
        </p>
      )}

      {data && data.selection.urgent.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-graphite">Using up:</span>
            {data.selection.urgent.map((i, idx) => (
              <StatusTag key={`${i.title}-${idx}`} tone={i.daysLeft <= 0 ? "negative" : "caution"}>
                {i.title}, {i.urgency === "today" ? "today" : i.urgency === "tomorrow" ? "tomorrow" : `${i.daysLeft} days`}
              </StatusTag>
            ))}
            {data.source !== "none" && (
              <StatusTag tone={data.source === "llm" ? "brand" : "neutral"} className="ml-auto">
                {SOURCE_LABEL[data.source]}
              </StatusTag>
            )}
          </div>

          {data.recipes.length === 0 && (
            <p className="rounded-2xl bg-fog p-4 text-sm text-graphite">
              No safe recipe could be built from these items. Use them soon, or check them below.
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {data.recipes.map((r, idx) => (
              <article key={`${r.title}-${idx}`} className="flex flex-col justify-between min-w-0 space-y-3 rounded-2xl bg-fog p-4 md:p-5">
                <div className="space-y-3">
                  <h3 className="break-words text-lg font-bold leading-tight text-graphite">{r.title}</h3>
                  <div className="flex flex-wrap gap-2">
                    <StatusTag tone="neutral" onWhite><Clock className="h-3.5 w-3.5" aria-hidden="true" />{r.timeMinutes} min</StatusTag>
                    <StatusTag tone="neutral" onWhite><Users className="h-3.5 w-3.5" aria-hidden="true" />Serves {r.servings}</StatusTag>
                  </div>
                  <p className="text-sm text-graphite"><span className="font-bold">Uses:</span> {r.usesItems.join(", ")}</p>
                  {r.extraPantryItems.length > 0 && (
                    <p className="text-sm text-graphite"><span className="font-bold">Extra pantry items:</span> {r.extraPantryItems.join(", ")}</p>
                  )}
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm text-graphite">
                    {r.steps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
                  </ol>
                  {r.tip && <p className="text-sm text-muted-foreground"><span className="font-bold text-graphite">Tip:</span> {r.tip}</p>}
                </div>

                <div className="space-y-3 pt-2">
                  {/* Instant Pantry-to-Cart Quick Commerce Integration */}
                  {r.extraPantryItems.length > 0 && (
                    <RecipeReorderCard
                      items={r.extraPantryItems}
                      title="Need extra ingredients? Order now:"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">{r.safetyNote}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {data && data.selection.needsInspection.length > 0 && (
        <div className="space-y-3 rounded-2xl bg-fog p-4 md:p-5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-sunset-orange" aria-hidden="true" />
            <h3 className="font-bold text-graphite">Check before use</h3>
          </div>
          <ul className="space-y-2">
            {data.selection.needsInspection.map((i, idx) => (
              <li key={`${i.title}-${idx}`} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm text-graphite bg-white/60 rounded-xl p-2.5">
                <div>
                  <span className="font-bold">{i.title}</span>
                  <span className="text-muted-foreground"> (expired {i.expiryDate})</span>
                  {i.note && <p className="mt-0.5 text-xs text-muted-foreground">{i.note}</p>}
                </div>
                {/* 1-Click Restock on Blinkit/Zepto for expired food */}
                <div className="shrink-0">
                  <ReorderButton item={i.title} size="sm" variant="outline" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
