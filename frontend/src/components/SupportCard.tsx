import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Mail, FileText, Shield, ExternalLink } from "lucide-react";

const SUPPORT_EMAIL = "support@atpressurewash.com";

export default function SupportCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Mail className="h-4 w-4" /> Support & Legal
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground leading-snug">
          Run into a bug, need to add a feature, or have a billing question? Reach out — we usually reply same day.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=Sterling%20Fence%20Staining%20Dashboard%20Support`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Mail className="h-3.5 w-3.5 mr-1" /> {SUPPORT_EMAIL}
          </a>
          <a
            href="/legal/eula"
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <FileText className="h-3.5 w-3.5 mr-1" /> EULA
            <ExternalLink className="h-3 w-3 ml-0.5 opacity-60" />
          </a>
          <a
            href="/legal/privacy"
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <Shield className="h-3.5 w-3.5 mr-1" /> Privacy Policy
            <ExternalLink className="h-3 w-3 ml-0.5 opacity-60" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
