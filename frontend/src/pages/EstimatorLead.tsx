import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type EstimatorLeadSummary } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import EstimatorLeadPanel from "@/components/EstimatorLeadPanel";
import { ArrowLeft, MapPin, Phone, Clock, Loader2 } from "lucide-react";

function fmtTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${period}`;
}

/** The estimator's own, price-free lead view (reached from their calendar).
 *  Deliberately NOT the full Lead Detail page — no pricing/proposal data ever
 *  reaches an estimator. Just who/where/when plus the capture panel. */
export default function EstimatorLead() {
  const { leadId } = useParams<{ leadId: string }>();
  const [lead, setLead] = useState<EstimatorLeadSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!leadId) return;
    setLoading(true);
    api.getEstimatorLead(leadId)
      .then(setLead)
      .catch(() => setLead(null))
      .finally(() => setLoading(false));
  }, [leadId]);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-2xl mx-auto">
      <Link to="/estimator" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to schedule
      </Link>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !lead ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Lead not found, or not on your schedule.</p>
      ) : (
        <>
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="font-semibold text-lg">{lead.contact_name || "Customer"}</div>
              {lead.visit && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4 shrink-0" />
                  <span>{lead.visit.visit_date} · {fmtTime(lead.visit.start_time)}</span>
                </div>
              )}
              {lead.address && (
                <a href={`https://maps.google.com/?q=${encodeURIComponent(lead.address)}`} target="_blank" rel="noreferrer"
                   className="flex items-start gap-2 text-sm text-primary hover:underline">
                  <MapPin className="h-4 w-4 mt-0.5 shrink-0" /> <span>{lead.address}</span>
                </a>
              )}
              {lead.contact_phone && (
                <a href={`tel:${lead.contact_phone}`} className="flex items-center gap-2 text-sm text-primary hover:underline">
                  <Phone className="h-4 w-4 shrink-0" /> {lead.contact_phone}
                </a>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <EstimatorLeadPanel leadId={lead.id} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
