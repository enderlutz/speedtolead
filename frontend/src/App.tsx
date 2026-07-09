import { useState, useCallback, useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { api, isAuthenticated, getCurrentUser, hasPerm, setToken } from "@/lib/api";
import Sidebar, { MobileHeader } from "@/components/Sidebar";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Leads from "@/pages/Leads";
import LeadsV2 from "@/pages/LeadsV2";
import LeadsPaintingUpsell from "@/pages/LeadsPaintingUpsell";
import LeadDetail from "@/pages/LeadDetail";
import SentLog from "@/pages/SentLog";
import Analytics from "@/pages/Analytics";
import Settings from "@/pages/Settings";
import EditPdf from "@/pages/EditPdf";
import Pricing from "@/pages/Pricing";
import ProposalView from "@/pages/ProposalView";
import QuickApprove from "@/pages/QuickApprove";
import AiFenceEstimation from "@/pages/AiFenceEstimation";
import Calls from "@/pages/Calls";
import Training from "@/pages/Training";
import ExteriorCapture from "@/pages/ExteriorCapture";
import Crew from "@/pages/Crew";
import CrewEmployee from "@/pages/CrewEmployee";
import CalendarPage from "@/pages/Calendar";
import MySchedule from "@/pages/MySchedule";
import Estimator from "@/pages/Estimator";
import EstimatorDay from "@/pages/EstimatorDay";
import CallListPanel from "@/components/CallListPanel";
import WrappedAutoPop from "@/components/WrappedAutoPop";
import TrainingBorder from "@/components/training/TrainingBorder";
import CallBar from "@/components/training/CallBar";
import CallSession from "@/components/training/CallSession";
import TrainingSummaryModal from "@/components/training/TrainingSummaryModal";
import { TrainingModeProvider } from "@/lib/training_mode_context";
import JobSops from "@/pages/JobSops";
import InvoiceQueue from "@/pages/InvoiceQueue";
import Revenue from "@/pages/Revenue";
import Accounting from "@/pages/Accounting";
import Agents from "@/pages/Agents";
import Internal from "@/pages/Internal";
import Eula from "@/pages/Eula";
import PrivacyPolicy from "@/pages/PrivacyPolicy";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

// Workers see only /my-schedule — any other URL bounces back. /calendar
// still works for them as a read-only fallback but /my-schedule is primary.
function StaffOnly({ children }: { children: React.ReactNode }) {
  const u = getCurrentUser();
  if (u?.role === "worker") return <Navigate to="/my-schedule" replace />;
  return <>{children}</>;
}

function FragnedOnly({ children }: { children: React.ReactNode }) {
  const u = getCurrentUser();
  if (u?.sub !== "fragned") return <Navigate to="/" replace />;
  return <>{children}</>;
}

// First page the user is allowed to land on — used when they hit a view they
// don't have permission for.
function landingFor(): string {
  if (hasPerm("dashboard")) return "/";
  if (hasPerm("estimator")) return "/estimator";
  if (hasPerm("my_schedule")) return "/my-schedule";
  if (hasPerm("calendar")) return "/calendar";
  return "/settings";
}

// Gate a route on a view permission. Bounces to the user's landing page when
// they lack it (covers both nav-hidden and direct-URL access).
function RequireView({ view, children }: { view: string; children: React.ReactNode }) {
  if (!hasPerm(view)) return <Navigate to={landingFor()} replace />;
  return <>{children}</>;
}

// Lead Detail access: staff with the leads view, OR the estimator (who reaches
// a specific lead from their day page to run the estimate — full experience,
// including pricing, which is appropriate for the in-person quote). The
// estimator still has no "leads" perm, so the Leads kanban/list stays hidden.
function RequireLeadDetail({ children }: { children: React.ReactNode }) {
  const u = getCurrentUser();
  if (hasPerm("leads") || u?.role === "estimator") return <>{children}</>;
  return <Navigate to={landingFor()} replace />;
}


function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const location = useLocation();
  // Bumped after a session refresh so nav/guards re-read the new token's perms.
  const [, setSessionRev] = useState(0);
  const currentUser = getCurrentUser();

  // On load, re-issue the token with freshly-resolved permissions so an admin's
  // permission/role change applies without the user logging out and back in.
  useEffect(() => {
    if (!isAuthenticated()) return;
    let alive = true;
    api.refreshSession()
      .then((r) => { if (alive && r?.token) { setToken(r.token); setSessionRev((n) => n + 1); } })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // Call List panel — shared callback queue. Admin + VA only. Workers
  // see it as a dead pill so we hide it entirely for them.
  const showCallList = !!currentUser && currentUser.role !== "worker" && currentUser.role !== "estimator";

  // Public pages without sidebar or auth
  const isPublic =
    location.pathname === "/login" ||
    location.pathname.startsWith("/proposal/") ||
    location.pathname.startsWith("/approve/") ||
    location.pathname.startsWith("/capture/") ||
    location.pathname.startsWith("/legal/");

  if (isPublic) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/approve/:token" element={<QuickApprove />} />
        <Route path="/capture/:token" element={<ExteriorCapture />} />
        <Route path="/legal/eula" element={<Eula />} />
        <Route path="/legal/privacy" element={<PrivacyPolicy />} />
      </Routes>
    );
  }

  return (
    <RequireAuth>
      <div className="flex h-dvh bg-background overflow-hidden">
        <Sidebar open={sidebarOpen} onClose={closeSidebar} />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <MobileHeader onToggle={() => setSidebarOpen(true)} />
          <main className="flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<RequireView view="dashboard"><Dashboard /></RequireView>} />
              <Route path="/leads" element={<RequireView view="leads"><LeadsV2 /></RequireView>} />
              <Route path="/leads/painting-upsell" element={<RequireView view="painting_upsell"><LeadsPaintingUpsell /></RequireView>} />
              <Route path="/old-leads" element={<StaffOnly><Leads /></StaffOnly>} />
              <Route path="/leads/:id" element={<RequireLeadDetail><LeadDetail /></RequireLeadDetail>} />
              <Route path="/leads/:id/edit-pdf" element={<RequireView view="leads"><EditPdf /></RequireView>} />
              <Route path="/sent-log" element={<StaffOnly><SentLog /></StaffOnly>} />
              <Route path="/analytics" element={<RequireView view="analytics"><Analytics /></RequireView>} />
              <Route path="/calls" element={<RequireView view="calls"><Calls /></RequireView>} />
              <Route path="/training" element={<RequireView view="training"><Training /></RequireView>} />
              <Route path="/crew" element={<RequireView view="payroll"><Crew /></RequireView>} />
              <Route path="/crew/:id" element={<RequireView view="payroll"><CrewEmployee /></RequireView>} />
              <Route path="/accounting" element={<RequireView view="accounting"><Accounting /></RequireView>} />
              <Route path="/calendar" element={<RequireView view="calendar"><CalendarPage /></RequireView>} />
              <Route path="/my-schedule" element={<RequireView view="my_schedule"><MySchedule /></RequireView>} />
              <Route path="/estimator" element={<RequireView view="estimator"><Estimator /></RequireView>} />
              <Route path="/estimator/day/:date" element={<RequireView view="estimator"><EstimatorDay /></RequireView>} />
              {/* Legacy bookmark redirect — old worker links pointed at /my-day */}
              <Route path="/my-day" element={<Navigate to="/my-schedule" replace />} />
              <Route path="/sops/job/:jobId" element={<JobSops />} />
              <Route path="/invoice-queue" element={<RequireView view="invoice_queue"><InvoiceQueue /></RequireView>} />
              <Route path="/revenue" element={<RequireView view="see_prices"><Revenue /></RequireView>} />
              <Route path="/pricing" element={<RequireView view="pricing"><Pricing /></RequireView>} />
              <Route path="/ai-fence" element={<StaffOnly><AiFenceEstimation /></StaffOnly>} />
              <Route path="/settings" element={<RequireView view="settings"><Settings /></RequireView>} />
              <Route path="/agents" element={<RequireView view="agents"><Agents /></RequireView>} />
              <Route path="/internal" element={<FragnedOnly><Internal /></FragnedOnly>} />
            </Routes>
          </main>
        </div>
        {showCallList && <CallListPanel />}
        {/* Saturday / last-of-month CEO digest. Mounted at AppLayout so
            it fires on any page, not just Dashboard. Admin-only inside. */}
        <WrappedAutoPop />

        {/* Training Mode — global red border + persistent call bar +
            fullscreen expand view + post-call summary modal. All driven
            by TrainingModeProvider state, so the rep can navigate any
            page while a practice call is running. */}
        <TrainingBorder />
        <CallBar />
        <CallSession />
        <TrainingSummaryModal />
      </div>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <TrainingModeProvider>
        <AppLayout />
        <Toaster position="top-right" richColors />
      </TrainingModeProvider>
    </BrowserRouter>
  );
}
