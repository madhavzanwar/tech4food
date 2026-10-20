import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useRoute, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle, ExternalLink, Lightbulb, MessageSquare, Leaf, Loader2, ScanLine, SearchX, UserRound } from "lucide-react";
import { PageHeader } from "@/components/brand/PageHeader";
import { StatusTag, riskTone, scoreTone, type Tone } from "@/components/brand/StatusTag";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/qc/States";
import { useState, useEffect, useRef } from "react";
import { playCleanChime, playWarningBuzz } from "@/lib/scannerAudio";
import { toast } from "sonner";
import { AIChatBox } from "@/components/AIChatBox";
import { HealthAlerts } from "@/components/features/HealthAlerts";
import { WhereToFindIt, useAlternativeMarket, useSeenOnce } from "@/components/features/AlternativeMarket";

function parseSources(raw?: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.join(", ") : String(parsed);
  } catch {
    return raw;
  }
}

export default function ScanResult() {
  const [, params] = useRoute("/scan/:id");
  const scanId = parseInt(params?.id || "0", 10) || 0;
  const utils = trpc.useUtils();
  const [loadingAlternatives, setLoadingAlternatives] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);

  const { data, isLoading, error: scanError, refetch: refetchScan } = trpc.scanner.getScan.useQuery({ scanId }, { enabled: scanId > 0, retry: false });
  const suggestAlternativesMutation = trpc.analysis.suggestAlternatives.useMutation();
  const { data: chatHistory, refetch: refetchChat } = trpc.chat.getHistory.useQuery({ scanId }, { enabled: scanId > 0 });
  const sendMessageMutation = trpc.chat.sendMessage.useMutation();
  // Real community price/availability data: only requested once alternatives exist and their list is near the viewport.
  const [altListEl, setAltListEl] = useState<HTMLElement | null>(null);
  const altSeen = useSeenOnce(altListEl);
  const market = useAlternativeMarket(scanId, altSeen && (data?.alternatives.length ?? 0) > 0);

  const playedAudioRef = useRef(false);
  useEffect(() => {
    if (data && data.scan && !playedAudioRef.current) {
      playedAudioRef.current = true;
      const score = data.scan.riskScore ?? 0;
      const hasHazardous = (data.ingredients ?? []).some(
        (i) => i.riskLevel === "severe" || i.riskLevel === "high"
      );
      if (hasHazardous || score >= 60) {
        playWarningBuzz();
      } else if (score <= 35) {
        playCleanChime();
      }
    }
  }, [data]);

  useEffect(() => {
    if (chatHistory) {
      setMessages(chatHistory.map(h => ({ role: h.role as "user" | "assistant", content: h.content })));
    }
  }, [chatHistory]);

  const handleSuggestAlternatives = async () => {
    if (!data?.scan.productName) {
      toast.error("Product name is required for alternatives");
      return;
    }
    setLoadingAlternatives(true);
    try {
      await suggestAlternativesMutation.mutateAsync({
        scanId,
        productName: data.scan.productName,
      });
      toast.success("Alternatives generated!");
      await utils.scanner.getScan.invalidate({ scanId });
    } catch (error: any) {
      toast.error(error.message || "Failed to generate alternatives");
    } finally {
      setLoadingAlternatives(false);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-8 pb-24 md:space-y-10" role="status" aria-busy="true" aria-label="Loading scan">
          <Skeleton className="h-24 w-full rounded-3xl bg-white" />
          <Skeleton className="h-40 w-full rounded-3xl bg-white" />
          <Skeleton className="h-64 w-full rounded-3xl bg-white" />
        </div>
      </DashboardLayout>
    );
  }

  // A network or server failure is not the same as a missing scan: offer a retry instead of "not found".
  if (!data && scanError && scanError.data?.code !== "NOT_FOUND" && scanError.data?.code !== "BAD_REQUEST") {
    return (
      <DashboardLayout>
        <ErrorState message={`Could not load this scan. ${scanError.message}`} onRetry={() => void refetchScan()} />
      </DashboardLayout>
    );
  }

  if (!data) {
    return (
      <DashboardLayout>
        <div className="rounded-3xl bg-white px-6 py-14 text-center md:py-20">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-fog" aria-hidden="true">
            <SearchX className="h-8 w-8 text-ember-orange" />
          </span>
          <p className="fn-heading-sm mt-6 text-graphite">Scan not found</p>
          <Button asChild className="mt-8 w-full sm:w-auto">
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  const { scan, ingredients, alternatives } = data;
  const score = scoreTone(scan.riskScore);

  return (
    <DashboardLayout>
      <div className="space-y-8 pb-24 md:space-y-10">
        <PageHeader
          eyebrow="Scan result"
          title={<span className="break-words">{scan.productName || "Scan Result"}</span>}
          description={`Scanned on ${new Date(scan.createdAt).toLocaleDateString()}`}
        />

        <div className={cn("grid gap-4 md:gap-6", scan.riskScore != null && "lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]")}>
          {scan.riskScore != null && (
            <section className="flex flex-col justify-between gap-6 rounded-3xl bg-white p-6 md:p-7" aria-label="Risk Score">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold text-muted-foreground">Risk Score</h2>
                <StatusTag tone={score.tone}>{score.label}</StatusTag>
              </div>
              <div className="flex items-end gap-2">
                <span className={cn("fn-metric text-6xl md:text-7xl", scoreTextClass(score.tone))}>{scan.riskScore}</span>
                <span className="pb-1.5 text-sm font-bold text-muted-foreground">out of 100</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-fog" aria-hidden="true">
                <div
                  className={cn("h-full rounded-full", scoreBarClass(score.tone))}
                  style={{ width: `${Math.min(100, Math.max(0, scan.riskScore))}%` }}
                />
              </div>
            </section>
          )}

          {/* Label Padhega India Educational Banner */}
          <section className="flex flex-col gap-4 rounded-3xl bg-white p-6 sm:flex-row sm:items-start md:p-7">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
              <Lightbulb className="h-5 w-5 text-ember-orange" />
            </span>
            <div className="min-w-0 space-y-2">
              <h3 className="text-lg font-bold leading-tight text-graphite">Label Padhega India</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                This analysis helps you understand hidden ingredients like sugars (maltodextrin, corn syrup),
                excessive salt, unhealthy oils, and harmful additives. Learn to read labels and make informed choices.
                Remember: ingredients are listed by quantity - the first few are the most abundant!
              </p>
            </div>
          </section>
        </div>

        <HealthAlerts scanId={scanId} />

        {scan.imageUrl && (
          <Card>
            <CardHeader><CardTitle>Scanned Image</CardTitle></CardHeader>
            <CardContent>
              <div className="rounded-2xl bg-fog p-3">
                <img src={scan.imageUrl} alt="Product label" className="mx-auto max-h-64 max-w-full rounded-xl" />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="fn-heading-sm">Ingredient Analysis</CardTitle>
              <StatusTag tone="brand">{ingredients.length} ingredients detected</StatusTag>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {ingredients.map((ingredient) => (
                <li key={ingredient.id} className="space-y-4 rounded-2xl bg-fog p-4 md:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <h3 className="break-words text-lg font-bold leading-tight text-graphite">{ingredient.name}</h3>
                      {ingredient.scientificName && <p className="break-words text-sm italic text-muted-foreground">{ingredient.scientificName}</p>}
                      {ingredient.category && (
                        <span className="mt-1 inline-flex rounded-3xl bg-white px-2.5 py-1 text-xs font-bold text-graphite">
                          {ingredient.category}
                        </span>
                      )}
                    </div>
                    {ingredient.riskLevel && (
                      <StatusTag tone={riskTone(ingredient.riskLevel)} onWhite className="self-start capitalize">
                        {ingredient.riskLevel}
                      </StatusTag>
                    )}
                  </div>
                  {ingredient.personalizedRisk && (
                    <div className="flex gap-3 rounded-xl bg-white p-3 md:p-4">
                      <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-ember-orange" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="mb-1 text-sm font-bold text-graphite">Personalized Risk:</p>
                        <p className="text-sm text-graphite">{ingredient.personalizedRisk}</p>
                      </div>
                    </div>
                  )}
                  {(ingredient.shortTermEffects || ingredient.longTermEffects || ingredient.sideEffects) && (
                    <div className="grid gap-3 text-sm md:grid-cols-3">
                      {ingredient.shortTermEffects && (
                        <div className="min-w-0">
                          <p className="font-bold text-muted-foreground">Short-term:</p>
                          <p className="text-graphite">{ingredient.shortTermEffects}</p>
                        </div>
                      )}
                      {ingredient.longTermEffects && (
                        <div className="min-w-0">
                          <p className="font-bold text-muted-foreground">Long-term:</p>
                          <p className="text-graphite">{ingredient.longTermEffects}</p>
                        </div>
                      )}
                      {ingredient.sideEffects && (
                        <div className="min-w-0">
                          <p className="font-bold text-muted-foreground">Side Effects:</p>
                          <p className="text-graphite">{ingredient.sideEffects}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {ingredient.sources && (
                    <div className="break-words text-xs text-muted-foreground">
                      Sources: {parseSources(ingredient.sources)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
                  <Leaf className="h-5 w-5 text-verdant-green" />
                </span>
                <div className="min-w-0 space-y-1">
                  <CardTitle className="fn-heading-sm">Healthier Alternatives</CardTitle>
                  <CardDescription>Safer product options based on your profile</CardDescription>
                </div>
              </div>
              {alternatives.length === 0 && (
                <Button onClick={handleSuggestAlternatives} disabled={loadingAlternatives} className="w-full sm:w-auto">
                  {loadingAlternatives ? <><Loader2 className="h-4 w-4 animate-spin" />Generating...</> : "Generate Alternatives"}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {alternatives.length > 0 ? (
              <ul ref={setAltListEl} className="space-y-3">
                {alternatives.map((alt) => (
                  <li key={alt.id} className="space-y-3 rounded-2xl bg-fog p-4 md:p-5">
                    <h3 className="flex items-start gap-2 text-lg font-bold leading-tight text-graphite">
                      <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-verdant-green" aria-hidden="true" />
                      <span className="min-w-0 break-words">{alt.productName}</span>
                    </h3>
                    {alt.brand && (
                      <p className="text-sm font-bold text-graphite">
                        Brand: <span className="font-normal">{alt.brand}</span>
                        <span className="ml-2 text-xs font-normal text-muted-foreground">AI suggestion, verify availability</span>
                      </p>
                    )}
                    <p className="text-sm text-graphite">{alt.reason}</p>
                    {alt.scientificJustification && (
                      <div className="rounded-xl bg-white p-3 text-sm md:p-4">
                        <p className="mb-1 font-bold text-graphite">Scientific Justification:</p>
                        <p className="text-graphite">{alt.scientificJustification}</p>
                      </div>
                    )}
                    <WhereToFindIt
                      item={market.data?.items.find((i) => i.alternativeId === alt.id)}
                      loading={!market.isError && !market.data && (market.isFetching || !altSeen)}
                      failed={market.isError}
                      retrying={market.isFetching}
                      onRetry={() => void market.refetch()}
                      attribution={market.data?.attribution}
                    />
                    {alt.sources && (
                      <div className="flex items-start gap-1.5 break-words text-xs text-muted-foreground">
                        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="min-w-0">Sources: {parseSources(alt.sources)}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-2xl bg-fog px-4 py-8 text-center text-sm text-muted-foreground">Click "Generate Alternatives" to see healthier options</p>
            )}
          </CardContent>
        </Card>

        {/* Inline Chat Section */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog" aria-hidden="true">
                  <MessageSquare className="h-5 w-5 text-ember-orange" />
                </span>
                <div className="min-w-0 space-y-1">
                  <CardTitle className="fn-heading-sm">Ask Questions About This Scan</CardTitle>
                  <CardDescription>
                    Get instant answers about ingredients, health impacts, and alternatives
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => setShowChat(!showChat)}
                className="w-full sm:w-auto"
                aria-expanded={showChat}
              >
                {showChat ? "Hide Chat" : "Show Chat"}
              </Button>
            </div>
          </CardHeader>
          {showChat && (
            <CardContent>
              <div className="h-[440px]">
                <AIChatBox
                  messages={messages}
                  isLoading={sendMessageMutation.isPending}
                  height="100%"
                  onSendMessage={async (message: string) => {
                    setMessages(prev => [...prev, { role: "user", content: message }]);
                    try {
                      const response = await sendMessageMutation.mutateAsync({ message, scanId });
                      setMessages(prev => [...prev, { role: "assistant", content: response.message }]);
                      refetchChat();
                    } catch (error: any) {
                      setMessages(prev => [...prev, { role: "assistant", content: `Error: ${error.message || "Failed to get response"}` }]);
                    }
                  }}
                  placeholder="Ask about ingredients, health impacts, or safer alternatives..."
                />
              </div>
            </CardContent>
          )}
        </Card>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href="/scanner"><ScanLine className="h-4 w-4" />Scan Another Product</Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
            <Link href="/history">View History</Link>
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}

function scoreTextClass(tone: Tone) {
  switch (tone) {
    case "positive":
      return "text-verdant-green";
    case "caution":
      return "text-sunset-orange";
    case "negative":
      return "text-signal-red-orange";
    default:
      return "text-graphite";
  }
}

function scoreBarClass(tone: Tone) {
  switch (tone) {
    case "positive":
      return "bg-verdant-green";
    case "caution":
      return "bg-sunset-orange";
    case "negative":
      return "bg-signal-red-orange";
    default:
      return "bg-graphite";
  }
}
