/**
 * Public end-user license agreement page. Required by Intuit for QuickBooks
 * Online app review. Renders standalone (no auth, no sidebar).
 *
 * Lives at /legal/eula on the production frontend.
 *
 * Content is tailored to Sterling Fence Staining's setup: an internal
 * admin dashboard used by company employees to manage leads, send
 * estimates, schedule jobs, and integrate with QuickBooks Online for
 * invoicing.
 */
import { Zap } from "lucide-react";

const COMPANY_LEGAL = "A&T's Fence Staining LLC";
const COMPANY_BRAND = "Sterling Fence Staining";
const SUPPORT_EMAIL = "bonneralan25@gmail.com";
const LAST_UPDATED = "May 8, 2026";

export default function Eula() {
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
          <h1 className="text-3xl font-bold tracking-tight">End-User License Agreement</h1>
          <p className="text-xs text-muted-foreground mt-2">Last updated: {LAST_UPDATED}</p>
        </div>

        <section>
          <p>
            This End-User License Agreement ("Agreement") is a legal contract between you and {COMPANY_LEGAL}
            ("Company," "we," "us," or "our") governing your access to and use of the {COMPANY_BRAND} dashboard
            and related services (the "Service"). By accessing or using the Service, you agree to be bound by this
            Agreement.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">1. Description of the Service</h2>
          <p>
            The Service is an internal business management dashboard that supports {COMPANY_LEGAL}'s fence-staining
            and pressure-washing operations. It is used by Company employees, contractors, and authorized
            agents to manage customer leads, prepare and send estimates, schedule jobs, coordinate field crews,
            and generate invoices through integrations with third-party platforms including (but not limited to)
            GoHighLevel, Google Calendar, and Intuit QuickBooks Online.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">2. License Grant</h2>
          <p>
            Subject to your compliance with this Agreement, the Company grants you a limited, non-exclusive,
            non-transferable, revocable license to access and use the Service solely for authorized business
            purposes on behalf of {COMPANY_LEGAL}. The Service is licensed, not sold.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">3. User Accounts and Responsibilities</h2>
          <p>You agree to:</p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li>Provide accurate information when creating or updating your account.</li>
            <li>Keep your login credentials confidential and not share them with anyone outside the Company.</li>
            <li>Notify the Company immediately of any unauthorized access to your account.</li>
            <li>Use the Service only for lawful purposes and in accordance with this Agreement.</li>
            <li>Comply with all applicable federal, state, and local laws and regulations.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">4. Restrictions</h2>
          <p>You shall not:</p>
          <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
            <li>Reverse-engineer, decompile, or disassemble any part of the Service.</li>
            <li>Copy, modify, distribute, sell, or lease any portion of the Service.</li>
            <li>Attempt to gain unauthorized access to the Service or its related systems or networks.</li>
            <li>Use the Service to transmit malware, spam, or any other harmful or illegal content.</li>
            <li>Use the Service in any manner that could damage, disable, overburden, or impair it.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">5. Third-Party Integrations</h2>
          <p>
            The Service integrates with third-party platforms, including Intuit QuickBooks Online for invoicing,
            GoHighLevel for customer messaging, Google Calendar for job scheduling, and Anthropic's Claude API
            for analysis features. Your use of those integrations is subject to the third party's own terms of
            service and privacy policies. The Company is not responsible for the practices of those third parties.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">6. Intellectual Property</h2>
          <p>
            All intellectual property rights in and to the Service, including software, design, and content,
            are owned by the Company or its licensors. Nothing in this Agreement transfers any of those rights
            to you.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">7. Termination</h2>
          <p>
            The Company may suspend or terminate your access to the Service at any time, with or without notice,
            for any reason, including violation of this Agreement. Upon termination, your right to use the
            Service ends immediately.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">8. Disclaimer of Warranties</h2>
          <p>
            The Service is provided "as is" and "as available" without warranties of any kind, whether express
            or implied. The Company disclaims all warranties, including merchantability, fitness for a particular
            purpose, and non-infringement. The Company does not warrant that the Service will be uninterrupted,
            error-free, or secure.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">9. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, the Company shall not be liable for any indirect, incidental,
            special, consequential, or punitive damages arising out of or related to your use of the Service.
            The Company's total liability shall not exceed one hundred U.S. dollars ($100).
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">10. Governing Law</h2>
          <p>
            This Agreement is governed by the laws of the State of Texas, without regard to its conflict of laws
            principles. Any disputes arising under this Agreement shall be resolved in the state or federal
            courts located in Harris County, Texas.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">11. Changes to This Agreement</h2>
          <p>
            The Company may update this Agreement from time to time. We will post the revised version on this
            page with a new "Last updated" date. Your continued use of the Service after changes are posted
            constitutes acceptance of the revised Agreement.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold mt-6 mb-2">12. Contact</h2>
          <p>
            Questions about this Agreement can be sent to{" "}
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
