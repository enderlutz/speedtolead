import { useState, useEffect, useRef } from "react";
import { api, type ChatbotConfig } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Bot, Save, Upload, Star, Loader2 } from "lucide-react";

export default function ChatbotSettings() {
  const [config, setConfig] = useState<ChatbotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getChatbotConfig()
      .then(setConfig)
      .catch(() => toast.error("Failed to load chatbot config"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await api.updateChatbotConfig(config);
      toast.success("Chatbot settings saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleUploadPicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be under 2MB");
      return;
    }
    setUploading(true);
    try {
      await api.uploadChatbotProfilePicture(file);
      setConfig((prev) => prev ? { ...prev, has_profile_picture: true } : prev);
      toast.success("Profile picture uploaded");
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const update = (field: keyof ChatbotConfig, value: unknown) => {
    setConfig((prev) => prev ? { ...prev, [field]: value } : prev);
  };

  if (loading) return <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">Loading chatbot settings...</CardContent></Card>;
  if (!config) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Bot className="h-4 w-4" /> Chatbot Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Enable toggle */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
            className="h-4 w-4 rounded"
          />
          <div>
            <p className="text-sm font-medium">Enable Chatbot</p>
            <p className="text-xs text-muted-foreground">Show Amy on proposal pages</p>
          </div>
        </label>

        {/* Bot name */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Bot Name</label>
          <Input value={config.bot_name} onChange={(e) => update("bot_name", e.target.value)} className="h-8" />
        </div>

        {/* Profile picture */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Profile Picture</label>
          <div className="flex items-center gap-3">
            {config.has_profile_picture ? (
              <img
                src={`${api.getChatbotProfilePictureUrl()}?v=${Date.now()}`}
                alt="Bot"
                className="h-12 w-12 rounded-full object-cover border"
              />
            ) : (
              <div className="h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center border">
                <span className="text-amber-700 font-bold">{config.bot_name[0] || "A"}</span>
              </div>
            )}
            <div>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                <Upload className="h-3.5 w-3.5 mr-1" />
                {uploading ? "Uploading..." : "Upload"}
              </Button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUploadPicture} />
              <p className="text-[10px] text-muted-foreground mt-0.5">Max 2MB, JPEG/PNG</p>
            </div>
          </div>
        </div>

        {/* Google Reviews */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Google Reviews</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Stars (1-5)</label>
              <Input
                type="number" min={1} max={5} step={0.1}
                value={config.google_review_stars}
                onChange={(e) => update("google_review_stars", parseFloat(e.target.value) || 5)}
                className="h-8"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Review Count</label>
              <Input
                type="number" min={0}
                value={config.google_review_count}
                onChange={(e) => update("google_review_count", parseInt(e.target.value) || 0)}
                className="h-8"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">Google Review Link</label>
            <Input
              value={config.google_review_link}
              onChange={(e) => update("google_review_link", e.target.value)}
              placeholder="https://g.page/..."
              className="h-8"
            />
          </div>
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className={`h-4 w-4 ${i < Math.round(config.google_review_stars) ? "text-amber-400 fill-amber-400" : "text-gray-300"}`} />
            ))}
            <span className="text-xs text-muted-foreground ml-1">{config.google_review_count} reviews</span>
          </div>
        </div>

        {/* Preset Questions */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">Preset Questions (shown as clickable bubbles)</p>
          {([1, 2, 3] as const).map((n) => {
            const qKey = `preset_q${n}` as keyof ChatbotConfig;
            const aKey = `preset_a${n}` as keyof ChatbotConfig;
            return (
              <div key={n} className="space-y-1 p-2.5 border rounded-lg bg-muted/20">
                <label className="text-[10px] font-medium text-muted-foreground">Question {n}</label>
                <Input
                  value={config[qKey] as string}
                  onChange={(e) => update(qKey, e.target.value)}
                  placeholder={`e.g. "How long does the staining last?"`}
                  className="h-8 text-sm"
                />
                <label className="text-[10px] font-medium text-muted-foreground">Answer {n}</label>
                <textarea
                  value={config[aKey] as string}
                  onChange={(e) => update(aKey, e.target.value)}
                  placeholder="The preset response..."
                  className="w-full border rounded-md px-3 py-1.5 text-sm bg-background resize-none"
                  rows={2}
                />
              </div>
            );
          })}
        </div>

        {/* System Prompt */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">System Prompt (for AI — coming soon)</label>
          <textarea
            value={config.system_prompt}
            onChange={(e) => update("system_prompt", e.target.value)}
            placeholder="You are Amy, a friendly customer service assistant for A&T Fence Restoration..."
            className="w-full border rounded-md px-3 py-2 text-sm bg-background resize-none"
            rows={4}
          />
        </div>

        {/* Test Lead IDs */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Test Lead IDs (comma-separated)</label>
          <Input
            value={config.test_only_lead_ids}
            onChange={(e) => update("test_only_lead_ids", e.target.value)}
            placeholder="Leave empty to enable for all leads"
            className="h-8 text-xs"
          />
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Restrict chatbot to specific leads for testing. Empty = enabled for all.
          </p>
        </div>

        {/* Save */}
        <Button onClick={handleSave} disabled={saving} className="w-full">
          <Save className="h-4 w-4 mr-1" /> {saving ? "Saving..." : "Save Chatbot Settings"}
        </Button>
      </CardContent>
    </Card>
  );
}
