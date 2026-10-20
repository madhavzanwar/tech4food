import { useState } from "react";
import { trpc } from "@/lib/trpc";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusTag } from "@/components/brand/StatusTag";
import { toast } from "sonner";
import {
  Users,
  Copy,
  Check,
  Plus,
  LogOut,
  ShieldCheck,
  Home,
  KeyRound,
  Sparkles,
  UserCheck,
  Edit2,
} from "lucide-react";

interface HouseholdManagerProps {
  trigger?: React.ReactNode;
}

export function HouseholdManager({ trigger }: HouseholdManagerProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"create" | "join">("create");
  const [createName, setCreateName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState("");

  const utils = trpc.useUtils();
  const { data: householdData, isLoading } = trpc.household.get.useQuery();

  const createMutation = trpc.household.create.useMutation({
    onSuccess: (res) => {
      toast.success(`Created "${res.household.name}"! Share code: ${res.household.inviteCode}`);
      setCreateName("");
      void utils.household.get.invalidate();
      void utils.inventory.list.invalidate();
      void utils.insights.ethyleneAlerts.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to create household");
    },
  });

  const joinMutation = trpc.household.join.useMutation({
    onSuccess: (res) => {
      toast.success(`Joined "${res.household.name}"! Shared pantry is now active.`);
      setJoinCode("");
      void utils.household.get.invalidate();
      void utils.inventory.list.invalidate();
      void utils.insights.ethyleneAlerts.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Invalid invite code");
    },
  });

  const leaveMutation = trpc.household.leave.useMutation({
    onSuccess: () => {
      toast.info("Left household. Reverted to your private pantry.");
      void utils.household.get.invalidate();
      void utils.inventory.list.invalidate();
      void utils.insights.ethyleneAlerts.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to leave household");
    },
  });

  const updateNameMutation = trpc.household.updateName.useMutation({
    onSuccess: () => {
      toast.success("Household renamed!");
      setIsEditingName(false);
      void utils.household.get.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to rename household");
    },
  });

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Invite code copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) {
      toast.error("Please enter a household name");
      return;
    }
    createMutation.mutate({ name: createName.trim() });
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = joinCode.trim().toUpperCase();
    if (!clean) {
      toast.error("Please enter the invite code");
      return;
    }
    joinMutation.mutate({ inviteCode: clean });
  };

  const handleRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    updateNameMutation.mutate({ name: newName.trim() });
  };

  const hasHousehold = Boolean(householdData?.household);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ? (
          trigger
        ) : (
          <Button
            variant={hasHousehold ? "secondary" : "outline"}
            className="flex-1 sm:flex-none gap-2 font-bold"
          >
            <Users className="h-4 w-4 text-verdant-green" />
            {hasHousehold
              ? `${householdData?.household.name} (${householdData?.members.length})`
              : "Share Fridge"}
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="text-left pr-8">
          <DialogTitle className="flex items-center gap-3 text-xl font-bold">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-fog">
              <Users className="h-5 w-5 text-ember-orange" />
            </span>
            {hasHousehold ? "Household Fridge" : "Multi-Member Household Fridge"}
          </DialogTitle>
          <DialogDescription>
            {hasHousehold
              ? "Share a live pantry with your family or flatmates directly in the app."
              : "Connect your household to share expiry alerts, smart fridge items, and zero-waste recipes without WhatsApp."}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground animate-pulse">
            Loading household details...
          </div>
        ) : hasHousehold && householdData ? (
          /* ================= Active Household View ================= */
          <div className="space-y-6 py-4">
            {/* Household Banner with Invite Code */}
            <div className="rounded-2xl border border-verdant-green/20 bg-verdant-green/5 p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Home className="h-4 w-4 text-verdant-green" />
                  {isEditingName ? (
                    <form onSubmit={handleRename} className="flex items-center gap-2">
                      <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="h-8 text-sm"
                        autoFocus
                      />
                      <Button size="sm" type="submit" disabled={updateNameMutation.isPending}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => setIsEditingName(false)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-graphite text-base">
                        {householdData.household.name}
                      </span>
                      {householdData.isOwner && (
                        <button
                          type="button"
                          onClick={() => {
                            setNewName(householdData.household.name);
                            setIsEditingName(true);
                          }}
                          className="text-muted-foreground hover:text-graphite transition-colors p-1"
                          title="Rename household"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <StatusTag tone="positive" onWhite>
                  {householdData.isOwner ? "Owner" : "Member"}
                </StatusTag>
              </div>

              {/* Invite Code Box */}
              <div className="rounded-xl bg-white p-3.5 border border-fog flex items-center justify-between gap-3 shadow-xs">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Invite Code (No WhatsApp required)
                  </p>
                  <p className="font-mono text-xl font-bold tracking-widest text-graphite mt-0.5">
                    {householdData.household.inviteCode}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 font-semibold shrink-0"
                  onClick={() => handleCopyCode(householdData.household.inviteCode)}
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 text-verdant-green" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy Code
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Family members or roommates can tap &ldquo;Share Fridge&rdquo; and enter this 6-character code to link.
              </p>
            </div>

            {/* Member List */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Fridge Members ({householdData.members.length})
                </Label>
                <span className="text-xs text-muted-foreground">Live synced</span>
              </div>

              <div className="divide-y divide-fog rounded-2xl border border-fog bg-white overflow-hidden">
                {householdData.members.map((member) => (
                  <div key={member.id} className="flex items-center justify-between p-3.5 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fog text-xs font-bold text-graphite">
                        {member.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-graphite truncate">
                          {member.name}
                        </p>
                        {member.email && (
                          <p className="text-xs text-muted-foreground truncate">
                            {member.email}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusTag tone={member.role === "owner" ? "info" : "neutral"} onWhite>
                        {member.role === "owner" ? "Fridge Admin" : "Family Member"}
                      </StatusTag>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Capabilities Info */}
            <div className="rounded-xl bg-fog p-3.5 text-xs text-muted-foreground space-y-1.5">
              <div className="flex items-center gap-1.5 font-bold text-graphite">
                <Sparkles className="h-3.5 w-3.5 text-ember-orange" />
                Shared Pantry Intelligence
              </div>
              <p>
                • Any item added by anyone in the household appears in all members&rsquo; fridges.
              </p>
              <p>
                • Ethylene shelf-spoilage alerts and zero-waste recipes automatically evaluate all shared groceries.
              </p>
            </div>

            {/* Leave Household */}
            <DialogFooter className="pt-2 sm:justify-between flex-row items-center border-t border-fog">
              <Button
                variant="ghost"
                size="sm"
                className="text-signal-red-orange hover:bg-signal-red-orange/10 hover:text-signal-red-orange gap-1.5"
                onClick={() => {
                  if (
                    confirm(
                      householdData.isOwner && householdData.members.length > 1
                        ? "Are you sure you want to leave? Ownership will transfer to another family member."
                        : "Are you sure you want to leave this household?"
                    )
                  ) {
                    leaveMutation.mutate();
                  }
                }}
                disabled={leaveMutation.isPending}
              >
                <LogOut className="h-4 w-4" />
                {leaveMutation.isPending ? "Leaving..." : "Leave Household"}
              </Button>

              <Button variant="secondary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* ================= Create / Join Tabs ================= */
          <div className="py-2">
            <Tabs
              value={activeTab}
              onValueChange={(v: any) => setActiveTab(v)}
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="create" className="gap-2 font-bold">
                  <Plus className="h-4 w-4" />
                  Create Fridge
                </TabsTrigger>
                <TabsTrigger value="join" className="gap-2 font-bold">
                  <KeyRound className="h-4 w-4" />
                  Join with Code
                </TabsTrigger>
              </TabsList>

              {/* Tab 1: Create Household */}
              <TabsContent value="create" className="space-y-4">
                <form onSubmit={handleCreate} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="household-name" className="text-sm font-bold">
                      Household or Fridge Name
                    </Label>
                    <Input
                      id="household-name"
                      placeholder="e.g., Smith Family Fridge, Apartment 302"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Creates a shared kitchen. You&rsquo;ll get a 6-character invite code to share with anyone in your house.
                    </p>
                  </div>

                  <div className="rounded-xl bg-fog p-3.5 text-xs text-muted-foreground space-y-1">
                    <p className="font-bold text-graphite flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 text-verdant-green" />
                      In-App Only — Zero WhatsApp Spam
                    </p>
                    <p>
                      No third-party messaging setup needed. Family members simply open the app, tap Join, and enter the code.
                    </p>
                  </div>

                  <Button
                    type="submit"
                    className="w-full font-bold h-11"
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending ? "Creating..." : "Create Household Fridge"}
                  </Button>
                </form>
              </TabsContent>

              {/* Tab 2: Join with Code */}
              <TabsContent value="join" className="space-y-4">
                <form onSubmit={handleJoin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-code" className="text-sm font-bold">
                      6-Character Invite Code
                    </Label>
                    <Input
                      id="invite-code"
                      placeholder="e.g., 7X9K2P"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      maxLength={10}
                      className="text-center font-mono text-xl tracking-widest uppercase font-bold"
                      required
                    />
                    <p className="text-xs text-muted-foreground text-center">
                      Ask your family member or flatmate for their household invite code.
                    </p>
                  </div>

                  <div className="rounded-xl bg-fog p-3.5 text-xs text-muted-foreground space-y-1">
                    <p className="font-bold text-graphite flex items-center gap-1.5">
                      <UserCheck className="h-3.5 w-3.5 text-verdant-green" />
                      Instant Sync
                    </p>
                    <p>
                      Joining merges your view with the household fridge inventory immediately.
                    </p>
                  </div>

                  <Button
                    type="submit"
                    className="w-full font-bold h-11"
                    disabled={joinMutation.isPending}
                  >
                    {joinMutation.isPending ? "Joining..." : "Join Household"}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Clean banner placed in FridgeTracker header when user belongs to an active household.
 */
export function HouseholdBanner() {
  const { data: householdData } = trpc.household.get.useQuery();
  const [copied, setCopied] = useState(false);

  if (!householdData?.household) return null;

  const { household, members } = householdData;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(household.inviteCode);
    setCopied(true);
    toast.success("Invite code copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-verdant-green/20 bg-verdant-green/5 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3 min-w-0">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-verdant-green shadow-xs">
          <Users className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-graphite truncate">
              {household.name}
            </span>
            <StatusTag tone="positive" onWhite className="text-xs">
              {members.length} {members.length === 1 ? "member" : "members"}
            </StatusTag>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <span>Invite Code:</span>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 font-mono font-bold text-graphite hover:text-verdant-green transition-colors"
              title="Click to copy invite code"
            >
              {household.inviteCode}
              {copied ? (
                <Check className="h-3 w-3 text-verdant-green" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>
          </p>
        </div>
      </div>

      <HouseholdManager
        trigger={
          <Button variant="outline" size="sm" className="h-8 text-xs font-bold gap-1.5 shrink-0">
            <Users className="h-3.5 w-3.5 text-verdant-green" />
            Manage Household
          </Button>
        }
      />
    </div>
  );
}
