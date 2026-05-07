import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Upload, X, Ruler, ExternalLink, Loader2 } from "lucide-react";

interface Props {
  leadId: string;
  hasMeasurement: boolean;
  uploadedAt?: string | null;
  uploadedBy?: string;
  filename?: string;
  onChange: () => void;
}

/** Single Google-Maps measurement screenshot per lead. Re-upload replaces;
 *  delete clears. Lives on the LeadDetail page, admin/VA-visible. */
export default function MeasurementCard({
  leadId, hasMeasurement, uploadedAt, uploadedBy, filename, onChange,
}: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load image when present; revoke the prior URL on change/unmount.
  useEffect(() => {
    if (!hasMeasurement) {
      setBlobUrl(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    api.fetchMeasurementBlobUrl(leadId).then((u) => {
      if (cancelled) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      url = u;
      setBlobUrl(u);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [leadId, hasMeasurement]);

  const upload = useCallback(async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      toast.error("File too big — please pick something under 15 MB");
      return;
    }
    setUploading(true);
    try {
      await api.uploadMeasurement(leadId, file);
      toast.success("Measurement uploaded");
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [leadId, onChange]);

  const handleDelete = async () => {
    if (!confirm("Delete the measurement screenshot?")) return;
    try {
      await api.deleteMeasurement(leadId);
      toast.success("Deleted");
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) upload(f);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Ruler className="h-4 w-4 text-primary" /> Measurement Screenshot
          <span className="text-xs font-normal text-muted-foreground">
            (Google Maps measurement, for admin review)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasMeasurement ? (
          <div className="space-y-2">
            <div className="border rounded-md overflow-hidden bg-muted/20">
              {blobUrl ? (
                <a href={blobUrl} target="_blank" rel="noreferrer" title="Open full size">
                  <img
                    src={blobUrl}
                    alt={filename || "Measurement"}
                    className="w-full max-h-96 object-contain bg-white"
                  />
                </a>
              ) : (
                <div className="h-40 grid place-items-center text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-2">
              <span>
                {filename || "measurement"}
                {uploadedBy && ` · uploaded by ${uploadedBy}`}
                {uploadedAt && ` · ${uploadedAt.slice(0, 10)}`}
              </span>
              <div className="flex gap-1">
                {blobUrl && (
                  <a href={blobUrl} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm">
                      <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                    </Button>
                  </a>
                )}
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  <Upload className="h-3.5 w-3.5 mr-1" /> Replace
                </Button>
                <Button variant="outline" size="sm" onClick={handleDelete} className="text-red-600 hover:text-red-700">
                  <X className="h-3.5 w-3.5 mr-1" /> Delete
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            className={`border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-input hover:border-primary/50 hover:bg-muted/30"
            }`}
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" />
            ) : (
              <>
                <Upload className="h-5 w-5 mx-auto text-muted-foreground" />
                <p className="text-sm mt-2">
                  <span className="font-medium text-primary">Click to upload</span> or drag & drop
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  PNG/JPG/PDF, up to 15 MB
                </p>
              </>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            // Allow re-selecting the same file later
            if (e.target) e.target.value = "";
          }}
        />
      </CardContent>
    </Card>
  );
}
