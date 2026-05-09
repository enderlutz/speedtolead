/**
 * Public privacy policy page. Required by Intuit for QuickBooks Online
 * app review — they read this carefully to understand what data we
 * touch and how we handle it. Lives at /legal/privacy on the production
 * frontend (no auth, no sidebar).
 *
 * Calls out the QuickBooks integration scope explicitly: we use the
 * Accounting API to create Invoice records on behalf of the connected
 * QuickBooks Online company, and we do not sell, share, or repurpose
 * QuickBooks data.
 */
import { Zap } from "lucide-react";

const COMPANY_LEGAL = "A&T's Fence Staining LLC";
const COMPANY_BRAND = "Sterling Fence Staining";
const SUPPORT_EMAIL = "support@atpressurewash.com";
const LAST_UPDATED = "May 8, 2026";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight">{COMPANY_BRAND}</p>
            <p className="text-[10px] text-muted-foreground">Operated by {COMPANY_LEGAL}</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-6 text-sm leading-relaxed">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
          <p className="text-xs text-muted-foreground mt-2">Last updated: {LAST_UPDATED}</p>
        </div>

        <section>
          <p>
            {COMPANY_LEGAL} ("Company," "we," "us," or "our") operates the {COMPANY_BRAND} dashboard
            (the "Service"), an internal business management tool used by Company employees to run
            our fence-staining and pressure-washing operations. This Privacy Policy explains what
            information we collect, how we use it, who we share it with, and the choices you have.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">1. Information We Collect</h2>

          <h3 className="text-sm font-bold mt-4 mb-1">From customers (lead data)</h3>
          <p>
            When a prospective customer submits a contact form on our marketing pages or contacts us
            through GoHighLevel, we collect:
          </p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li>Name, phone number, and email address</li>
            <li>Property address and ZIP code</li>
            <li>Fence specifications they provide (linear feet, height, age, sides to be stained)</li>
            <li>Timeline preferences and additional service requests</li>
          </ul>

          <h3 className="text-sm font-bold mt-4 mb-1">From QuickBooks Online (when integrated)</h3>
          <p>
            When the Company connects the Service to its QuickBooks Online company, we access the
            following through Intuit's Accounting API solely to create and track customer invoices:
          </p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li>Company name and unique QuickBooks company identifier ("realm ID")</li>
            <li>Customer records associated with invoices we create</li>
            <li>Invoice records we create and their payment status</li>
            <li>OAuth refresh and access tokens for the connected QuickBooks company</li>
          </ul>
          <p className="mt-2">
            We do <strong>not</strong> access bank account data, payroll data, or any QuickBooks data
            outside the Accounting scope strictly necessary to support invoicing.
          </p>

          <h3 className="text-sm font-bold mt-4 mb-1">From employees</h3>
          <p>
            Company employees who log into the Service have basic account information stored: display
            name, email, role, hashed password, and activity timestamps. Field crew may also upload
            time entries, photos of completed work, and reimbursement receipts.
          </p>

          <h3 className="text-sm font-bold mt-4 mb-1">From service usage</h3>
          <p>
            Standard server logs (IP address, request path, timestamp, status code) are recorded for
            operations and security. We do not use third-party analytics or advertising trackers on
            this Service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">2. How We Use Information</h2>
          <p>We use the information we collect to:</p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li>Provide the Service to {COMPANY_LEGAL}'s employees.</li>
            <li>Generate accurate fence-staining and pressure-washing estimates for prospective customers.</li>
            <li>Schedule and coordinate field crews for customer jobs.</li>
            <li>Create QuickBooks invoices and track when they are paid by customers.</li>
            <li>Send transactional text messages (such as estimate links and appointment confirmations) via GoHighLevel.</li>
            <li>Operate, maintain, and improve the Service.</li>
            <li>Comply with legal obligations.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">3. How We Share Information</h2>
          <p>
            We do not sell personal information. We share data only with the third-party service
            providers listed below, and only to the extent necessary to operate the Service:
          </p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li><strong>Intuit QuickBooks Online</strong> — to create invoices and read payment status. QuickBooks data we access stays within QuickBooks; we do not redistribute it.</li>
            <li><strong>GoHighLevel</strong> — to send and receive customer text messages and sync lead pipeline status.</li>
            <li><strong>Google Calendar</strong> — to write scheduled job events to the Company's connected Google Calendar.</li>
            <li><strong>Anthropic (Claude API)</strong> — for analysis features (e.g., generating the weekly business briefing). Lead and operational data may be sent in prompts; Anthropic does not use this data to train models per their commercial API terms.</li>
            <li><strong>Hosting providers</strong> — Railway (US-based application hosting) and Supabase (US-based managed PostgreSQL database).</li>
            <li><strong>Twilio (via GoHighLevel)</strong> — for SMS message delivery.</li>
          </ul>
          <p className="mt-2">
            We may also disclose information when required by law, to protect our legal rights, or in
            connection with a corporate transaction such as a sale of the business.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">4. QuickBooks Data Use Disclosure</h2>
          <p>
            Specific to our QuickBooks integration:
          </p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li>We use only the OAuth scope required for invoicing (<code className="px-1 bg-muted rounded text-xs">com.intuit.quickbooks.accounting</code>).</li>
            <li>We do not share, sell, or transfer QuickBooks data to any third party other than the integrated services listed above for the limited purposes stated.</li>
            <li>We do not use QuickBooks data for advertising, marketing analytics, or any purpose unrelated to the Service.</li>
            <li>QuickBooks data is retained only as long as the QuickBooks connection is active. Disconnecting QuickBooks revokes our tokens and stops further data access.</li>
            <li>The Company may request deletion of QuickBooks-related data at any time by contacting us at the address below.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">5. Data Security</h2>
          <p>
            All traffic to and from the Service is encrypted in transit using TLS (HTTPS). Data at rest
            is stored on managed infrastructure (Railway and Supabase) with provider-level encryption.
            Access to administrative data requires authentication, and sensitive operations are
            restricted by role.
          </p>
          <p className="mt-2">
            No system can be guaranteed 100% secure. If you believe your account has been compromised,
            contact us immediately at the address below.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">6. Data Retention</h2>
          <p>
            Customer lead and job data is retained for as long as it is needed to operate the
            Company's business and to comply with legal obligations (typically the duration of the
            customer relationship plus seven years for tax records). QuickBooks tokens are deleted
            immediately upon disconnection. Server logs are retained for up to 90 days.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">7. Your Rights</h2>
          <p>
            Depending on the laws of your jurisdiction, you may have rights to access, correct,
            delete, or restrict the processing of your personal information. To exercise any of
            these rights, contact us at the address below. We will respond within a reasonable time
            and in accordance with applicable law.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">8. Children's Privacy</h2>
          <p>
            The Service is not intended for use by children under 13 years of age, and we do not
            knowingly collect personal information from children.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">9. International Users</h2>
          <p>
            The Service is operated from and hosted in the United States. If you access the Service
            from outside the U.S., your information will be transferred to and processed in the U.S.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">10. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. The revised version will be posted
            on this page with a new "Last updated" date. Material changes will be communicated to
            account holders by email or in-app notice.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">11. Contact</h2>
          <p>
            Questions, requests, or concerns about this Privacy Policy can be sent to{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:underline">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </section>

        <footer className="pt-8 border-t mt-12 text-xs text-muted-foreground">
          © {new Date().getFullYear()} {COMPANY_LEGAL}. All rights reserved.
        </footer>
      </main>
    </div>
  );
}
