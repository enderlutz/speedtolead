import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { FileText, UploadCloud, X, Send, Loader2 } from "lucide-react";

/** Upload a pre-made PDF and send it to the customer as a proposal — same
 * /proposal link, viewer, and SMS as a generated estimate. For one-off custom
 * quotes where the PDF is built outside the dashboard. */
export default function CustomProposalCard({
  leadId,
  pipelineVersion,
  onSent,
}: {
  leadId: string;
  pipelineVersion?: string;
  onSent?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isV1 = pipelineVersion === "v1";

  const pick = (f: File | null) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Please choose a PDF file.");
      return;
    }
    setFile(f);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0] || null);
  };

  const send = async () => {
    if (!file) return;
    setSending(true);
    try {
      const res = await api.sendCustomProposal(leadId, file);
      if (res.sms_sent) {
        toast.success(`Custom proposal sent — ${res.page_count} page${res.page_count === 1 ? "" : "s"} texted to the customer.`);
      } else {
        toast.warning(`Proposal created (${res.page_count} pages) but no SMS went out — check the customer has a phone/contact. Link: ${res.proposal_url}`, { duration: 10000 });
      }
      setFile(null);
      onSent?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send custom proposal");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div>
          <p className="text-sm font-semibold flex items-center gap-1.5">
            <FileText className="h-4 w-4" /> Send a custom PDF
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Upload your own proposal PDF. The customer gets the same link + viewer and a text — just like a normal estimate.
          </p>
        </div>

        {file ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2.5">
            <FileText className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium truncate">{file.name}</p>
              <p className="text-[10px] text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
            <button onClick={() => setFile(null)} className="text-muted-foreground hover:text-foreground" title="Remove">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <label
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${
              dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/40 hover:bg-muted/30"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0] || null)}
            />
            <UploadCloud className="h-6 w-6 text-muted-foreground" />
            <p className="text-xs font-medium">Drag &amp; drop a PDF here</p>
            <p className="text-[10px] text-muted-foreground">or click to choose a file</p>
          </label>
        )}

        <Button
          onClick={send}
          disabled={!file || sending || isV1}
          title={isV1 ? "Export this lead to the new pipeline before sending" : "Sends the PDF + texts the customer the link, and applies the 'estimate sent' GHL tag"}
          className="w-full bg-green-600 hover:bg-green-700 text-white disabled:bg-gray-300"
        >
          {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
          {sending ? "Sending…" : "Send Custom Proposal"}
        </Button>
        {isV1 && (
          <p className="text-[11px] text-center text-amber-700">Export to the new pipeline first to send.</p>
        )}
      </CardContent>
    </Card>
  );
}
