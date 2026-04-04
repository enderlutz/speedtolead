import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Upload, Trash2, FileText, Search, ChevronDown, ChevronRight,
  BarChart3, Database, Send,
} from "lucide-react";
import PdfTemplateEditor from "@/components/PdfTemplateEditor";

interface PdfTemplateInfo {
  id: string;
  filename: string;
  page_count: number;
  field_map: Record<string, unknown>;
}

interface SystemStats {
  total_leads: number;
  total_estimates: number;
  sent_estimates: number;
}

export default function Settings() {
  // PDF Template state
  const [template, setTemplate] = useState<PdfTemplateInfo | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // GHL state
  const [pipelines, setPipelines] = useState<Record<string, unknown[]> | null>(null);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [pipelinesOpen, setPipelinesOpen] = useState(false);
  const [fields, setFields] = useState<Record<string, unknown[]> | null>(null);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  // Stats state
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    api
      .getPdfTemplate()
      .then(setTemplate)
      .catch(() => setTemplate(null))
      .finally(() => setTemplateLoading(false));

    api
      .getStats()
      .then(setStats)
      .catch(() => toast.error("Failed to load stats"))
      .finally(() => setStatsLoading(false));
  }, []);

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Only PDF files are allowed");
      return;
    }
    setUploading(true);
    try {
      const result = await api.uploadPdfTemplate(file);
      setTemplate({ ...result, field_map: result.field_map ?? {} });
      toast.success("Template uploaded");
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  const safeFieldMap = (template?.field_map ?? {}) as Record<string, { page: number; x: number; y: number; font_size: number; color?: string }>;

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDeleteTemplate = async () => {
    // Reset template display (backend would need a delete endpoint)
    setTemplate(null);
    toast.success("Template removed");
  };

  const handleDiscoverPipelines = async () => {
    setPipelinesLoading(true);
    try {
      const data = await api.getGhlPipelines();
      setPipelines(data);
      setPipelinesOpen(true);
      toast.success("Pipelines discovered");
    } catch {
      toast.error("Failed to discover pipelines");
    } finally {
      setPipelinesLoading(false);
    }
  };

  const handleDiscoverFields = async () => {
    setFieldsLoading(true);
    try {
      const data = await api.getGhlFields();
      setFields(data);
      setFieldsOpen(true);
      toast.success("Fields discovered");
    } catch {
      toast.error("Failed to discover fields");
    } finally {
      setFieldsLoading(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-3xl">
      <h1 className="text-lg sm:text-2xl font-semibold tracking-tight">
        Settings
      </h1>

      {/* PDF Template */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            PDF Template
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {templateLoading ? (
            <div className="h-10 bg-muted rounded animate-pulse" />
          ) : template ? (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-muted/30">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {template.filename}
                </p>
                <p className="text-xs text-muted-foreground">
                  {template.page_count} page{template.page_count !== 1 ? "s" : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDeleteTemplate}
                className="text-red-500 hover:text-red-600 hover:bg-red-50 shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No template uploaded</p>
          )}

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !uploading && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            } ${uploading ? "opacity-50 pointer-events-none" : ""}`}
          >
            <Input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleUpload}
              className="hidden"
              id="pdf-upload"
            />
            <Upload className={`h-8 w-8 mx-auto mb-2 ${dragging ? "text-primary" : "text-muted-foreground/50"}`} />
            <p className="text-sm font-medium">{uploading ? "Uploading..." : "Drag & drop PDF here"}</p>
            <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
          </div>

          {/* Template Editor */}
          {template && (
            <PdfTemplateEditor
              pageCount={template.page_count}
              pageSizes={(template as unknown as { page_sizes?: { width: number; height: number }[] }).page_sizes || []}
              initialFieldMap={safeFieldMap}
              onSave={(fieldMap) => setTemplate((prev) => prev ? { ...prev, field_map: fieldMap } : prev)}
            />
          )}
        </CardContent>
      </Card>

      {/* GHL Pipelines */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <Database className="h-4 w-4" />
            GHL Pipelines & Fields
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={handleDiscoverPipelines}
              disabled={pipelinesLoading}
            >
              <Search className="h-4 w-4 mr-2" />
              {pipelinesLoading ? "Discovering..." : "Discover Pipelines"}
            </Button>
            <Button
              variant="outline"
              onClick={handleDiscoverFields}
              disabled={fieldsLoading}
            >
              <Search className="h-4 w-4 mr-2" />
              {fieldsLoading ? "Discovering..." : "Discover Fields"}
            </Button>
          </div>

          {/* Pipelines result */}
          {pipelines && (
            <div className="border rounded-lg">
              <button
                onClick={() => setPipelinesOpen(!pipelinesOpen)}
                className="w-full flex items-center justify-between p-3 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                <span>Pipelines ({Object.keys(pipelines).length})</span>
                {pipelinesOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              {pipelinesOpen && (
                <div className="border-t px-3 pb-3 space-y-3">
                  {Object.entries(pipelines).map(([name, stages]) => (
                    <div key={name} className="pt-3">
                      <p className="text-sm font-semibold">{name}</p>
                      <div className="mt-1 space-y-0.5">
                        {Array.isArray(stages) &&
                          stages.map((stage, i) => (
                            <p
                              key={i}
                              className="text-xs text-muted-foreground pl-3"
                            >
                              {typeof stage === "object" && stage !== null
                                ? (stage as Record<string, string>).name ||
                                  JSON.stringify(stage)
                                : String(stage)}
                            </p>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Fields result */}
          {fields && (
            <div className="border rounded-lg">
              <button
                onClick={() => setFieldsOpen(!fieldsOpen)}
                className="w-full flex items-center justify-between p-3 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                <span>Custom Fields ({Object.keys(fields).length})</span>
                {fieldsOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              {fieldsOpen && (
                <div className="border-t px-3 pb-3 space-y-1 max-h-64 overflow-y-auto">
                  {Object.entries(fields).map(([key, values]) => (
                    <div key={key} className="pt-2">
                      <p className="text-xs font-medium">{key}</p>
                      {Array.isArray(values) &&
                        values.map((v, i) => (
                          <p
                            key={i}
                            className="text-xs text-muted-foreground pl-3 truncate"
                          >
                            {typeof v === "object" && v !== null
                              ? (v as Record<string, string>).name ||
                                (v as Record<string, string>).key ||
                                JSON.stringify(v)
                              : String(v)}
                          </p>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* System Stats */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            System Stats
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 bg-muted rounded animate-pulse" />
              ))}
            </div>
          ) : stats ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <Database className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-2xl font-bold">{stats.total_leads}</p>
                <p className="text-xs text-muted-foreground">Total Leads</p>
              </div>
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <BarChart3 className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-2xl font-bold">{stats.total_estimates}</p>
                <p className="text-xs text-muted-foreground">Total Estimates</p>
              </div>
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <Send className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-2xl font-bold">{stats.sent_estimates}</p>
                <p className="text-xs text-muted-foreground">Sent Estimates</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Failed to load stats
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
