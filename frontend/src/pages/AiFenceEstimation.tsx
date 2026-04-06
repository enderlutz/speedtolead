import { useState } from "react";
import { api } from "@/lib/api";
// import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Brain, Search, MapPin, Ruler, AlertTriangle, CheckCircle2,
  RefreshCw, Loader2, Eye, TreePine, Copy,
} from "lucide-react";

interface FenceSegment {
  label: string;
  side: string;
  length_ft: number;
  material?: string;
  stainable?: boolean;
  confidence: string;
  is_curved?: boolean;
  notes: string;
}

interface AnalysisResult {
  id: string;
  address: string;
  lat: number;
  lng: number;
  zip_code: string;
  images?: { zoom: number; label: string; base64: string }[];
  analysis: {
    property_description?: string;
    fence_detected?: boolean;
    fence_material?: string;
    fence_color?: string;
    segments: FenceSegment[];
    total_linear_feet: number;
    overall_confidence: string;
    obstructions?: string;
    measurement_notes?: string;
    sanity_warning?: string;
    input_tokens?: number;
    output_tokens?: number;
  };
  total_linear_feet: number;
  overall_confidence: string;
  cached: boolean;
  created_at: string;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  HIGH: "bg-green-100 text-green-800",
  MEDIUM: "bg-yellow-100 text-yellow-800",
  LOW: "bg-red-100 text-red-800",
};

export default function AiFenceEstimation() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [activeImage, setActiveImage] = useState(0);

  const handleAnalyze = async (force = false) => {
    if (!address.trim()) {
      toast.error("Enter an address");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const data = await api.analyzeFence(address, force);
      setResult(data as unknown as AnalysisResult);
      if (data.cached) {
        toast.info("Loaded from cache. Click Re-Analyze for fresh results.");
      } else {
        toast.success(`Analysis complete: ${data.total_linear_feet} LF detected`);
      }
    } catch (e) {
      toast.error("Analysis failed. Check address and try again.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const copyMeasurement = () => {
    if (!result) return;
    const stainable = (result.analysis as Record<string, unknown>).total_stainable_linear_feet as number ?? result.total_linear_feet;
    navigator.clipboard.writeText(String(stainable));
    toast.success("Copied stainable LF to clipboard");
  };

  const analysis = result?.analysis;
  const images = result?.images || [];

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Brain className="h-6 w-6 text-purple-600" /> AI Fence Estimation
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Claude Vision-powered fence measurement from satellite imagery
        </p>
      </div>

      {/* Address Input */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Enter property address..."
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
                className="pl-9"
              />
            </div>
            <Button onClick={() => handleAnalyze()} disabled={loading} className="bg-purple-600 hover:bg-purple-700 text-white">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span className="ml-1.5 hidden sm:inline">{loading ? "Analyzing..." : "Analyze"}</span>
            </Button>
          </div>
          {loading && (
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Fetching satellite imagery and analyzing with Claude Vision... This takes 10-15 seconds.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {result && analysis && (
        <>
          {/* KPI Row */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Card className="border-purple-200 bg-purple-50/30">
              <CardContent className="pt-4">
                <p className="text-[10px] sm:text-xs text-purple-600 font-medium">Stainable (Wood)</p>
                <p className="text-2xl font-bold text-purple-700">{(analysis as Record<string, unknown>).total_stainable_linear_feet as number ?? analysis.total_linear_feet} ft</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-[10px] sm:text-xs text-muted-foreground">Total All Fences</p>
                <p className="text-2xl font-bold">{analysis.total_linear_feet} ft</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-[10px] sm:text-xs text-muted-foreground">Confidence</p>
                <Badge className={`text-sm mt-1 ${CONFIDENCE_STYLES[analysis.overall_confidence] || ""}`}>
                  {analysis.overall_confidence}
                </Badge>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-[10px] sm:text-xs text-muted-foreground">Segments</p>
                <p className="text-2xl font-bold">{analysis.segments?.length || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-[10px] sm:text-xs text-muted-foreground">Non-Stainable</p>
                <p className="text-sm font-medium text-red-600 mt-1">{(analysis as Record<string, unknown>).total_non_stainable_linear_feet as number ?? 0} ft</p>
              </CardContent>
            </Card>
          </div>

          {/* Sanity Warning */}
          {analysis.sanity_warning && (
            <Card className="border-amber-300 bg-amber-50">
              <CardContent className="pt-4 flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-sm text-amber-800">{analysis.sanity_warning}</p>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Satellite Images */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Eye className="h-4 w-4" /> Satellite Imagery
                  {result.cached && <Badge variant="outline" className="text-[10px]">Cached</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {images.length > 0 ? (
                  <>
                    <div className="rounded-lg overflow-hidden border mb-2">
                      <img
                        src={`data:image/png;base64,${images[activeImage]?.base64}`}
                        alt={`Satellite view - ${images[activeImage]?.label}`}
                        className="w-full"
                      />
                    </div>
                    <div className="flex gap-1">
                      {images.map((img, i) => (
                        <button
                          key={i}
                          onClick={() => setActiveImage(i)}
                          className={`flex-1 text-xs py-1.5 px-2 rounded transition-colors ${
                            i === activeImage ? "bg-purple-100 text-purple-800 font-medium" : "bg-muted text-muted-foreground hover:bg-muted/80"
                          }`}
                        >
                          {img.label === "overview" ? "Overview" : img.label === "close-up" ? "Close-up" : "Offset"}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Images not available (loaded from cache)
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Measurements */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Ruler className="h-4 w-4" /> Fence Measurements
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Property Description */}
                {analysis.property_description && (
                  <p className="text-sm text-muted-foreground">{analysis.property_description}</p>
                )}

                {/* Segments Table */}
                {analysis.segments && analysis.segments.length > 0 ? (
                  <div className="rounded-md border overflow-hidden">
                    <div className="grid grid-cols-[1fr_60px_70px] gap-0 text-xs font-medium text-muted-foreground bg-muted/40 px-3 py-2">
                      <span>Segment</span>
                      <span className="text-right">Length</span>
                      <span className="text-right">Conf.</span>
                    </div>
                    {analysis.segments.map((seg, i) => (
                      <div key={i} className={`grid grid-cols-[1fr_60px_70px] gap-0 px-3 py-2.5 text-sm ${seg.stainable === false ? "bg-red-50/50" : i % 2 === 0 ? "bg-white" : "bg-muted/10"}`}>
                        <div>
                          <span className="font-medium">{seg.label}</span>
                          {seg.stainable === false && <Badge className="text-[9px] bg-red-100 text-red-700 ml-1.5">Not Stainable</Badge>}
                          <span className="text-xs text-muted-foreground ml-1.5">
                            {seg.material ? `(${seg.material})` : ""}
                            {seg.is_curved ? " curved" : ""}
                          </span>
                          {seg.notes && <p className="text-xs text-muted-foreground mt-0.5">{seg.notes}</p>}
                        </div>
                        <span className={`text-right font-bold ${seg.stainable === false ? "text-red-400 line-through" : ""}`}>{seg.length_ft} ft</span>
                        <span className="text-right">
                          <Badge className={`text-[9px] ${CONFIDENCE_STYLES[seg.confidence] || ""}`}>
                            {seg.confidence}
                          </Badge>
                        </span>
                      </div>
                    ))}
                    <div className="grid grid-cols-[1fr_60px_70px] gap-0 px-3 py-2.5 text-sm bg-purple-50 border-t font-bold">
                      <span>Total</span>
                      <span className="text-right text-purple-700">{analysis.total_linear_feet} ft</span>
                      <span></span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No fence segments detected</p>
                )}

                {/* Obstructions */}
                {analysis.obstructions && (
                  <div className="flex items-start gap-2 text-sm bg-amber-50 rounded-md p-2.5 border border-amber-200">
                    <TreePine className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-800 text-xs">Obstructions</p>
                      <p className="text-amber-700">{analysis.obstructions}</p>
                    </div>
                  </div>
                )}

                {/* Measurement Notes */}
                {analysis.measurement_notes && (
                  <p className="text-xs text-muted-foreground">{analysis.measurement_notes}</p>
                )}

                {/* Token usage */}
                {analysis.input_tokens && (
                  <p className="text-[10px] text-muted-foreground">
                    Tokens: {analysis.input_tokens} in / {analysis.output_tokens} out
                    {" "}(~${((analysis.input_tokens * 0.003 + (analysis.output_tokens || 0) * 0.015) / 1000).toFixed(3)})
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Actions */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-2">
                <Button onClick={copyMeasurement} variant="outline" size="sm">
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy {analysis.total_linear_feet} LF
                </Button>
                <Button onClick={() => handleAnalyze(true)} variant="outline" size="sm" disabled={loading}>
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Re-Analyze
                </Button>
                <a
                  href={`https://www.google.com/maps/@?api=1&map_action=map&basemap=satellite&center=${encodeURIComponent(result.address)}&zoom=20`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="outline" size="sm">
                    <MapPin className="h-3.5 w-3.5 mr-1" /> Open in Google Maps
                  </Button>
                </a>
              </div>

              {/* Address + metadata */}
              <div className="mt-3 text-xs text-muted-foreground space-y-0.5">
                <p>Address: {result.address}</p>
                <p>ZIP: {result.zip_code} | Lat: {result.lat?.toFixed(5)} | Lng: {result.lng?.toFixed(5)}</p>
                <p>Analyzed: {new Date(result.created_at).toLocaleString()} {result.cached ? "(cached)" : ""}</p>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Empty State */}
      {!result && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Brain className="h-12 w-12 text-purple-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">AI-Powered Fence Measurement</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Enter a property address above. Claude Vision will analyze satellite imagery
              to detect and measure all fence segments with confidence scores.
            </p>
            <div className="flex justify-center gap-4 mt-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> ~$0.02/analysis</span>
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> 10-15 sec</span>
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Per-side confidence</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
