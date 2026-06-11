import { useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { isAuthenticated, getCurrentUser } from "@/lib/api";
import Sidebar, { MobileHeader } from "@/components/Sidebar";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Leads from "@/pages/Leads";
import LeadsV2 from "@/pages/LeadsV2";
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
import Crew from "@/pages/Crew";
import CrewEmployee from "@/pages/CrewEmployee";
import CalendarPage from "@/pages/Calendar";
import MySchedule from "@/pages/MySchedule";
import CallListPanel from "@/components/CallListPanel";
import WrappedAutoPop from "@/components/WrappedAutoPop";
import JobSops from "@/pages/JobSops";
import InvoiceQueue from "@/pages/InvoiceQueue";
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

function AdminOnly({ children }: { children: React.ReactNode }) {
  const u = getCurrentUser();
  if (u?.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function FragnedOnly({ children }: { children: React.ReactNode }) {
  const u = getCurrentUser();
  if (u?.sub !== "fragned") return <Navigate to="/" replace />;
  return <>{children}</>;
}


function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const location = useLocation();
  const currentUser = getCurrentUser();
  // Call List panel — shared callback queue. Admin + VA only. Workers
  // see it as a dead pill so we hide it entirely for them.
  const showCallList = !!currentUser && currentUser.role !== "worker";

  // Public pages without sidebar or auth
  const isPublic =
    location.pathname === "/login" ||
    location.pathname.startsWith("/proposal/") ||
    location.pathname.startsWith("/approve/") ||
    location.pathname.startsWith("/legal/");

  if (isPublic) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/approve/:token" element={<QuickApprove />} />
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
              <Route path="/" element={<StaffOnly><Dashboard /></StaffOnly>} />
              <Route path="/leads" element={<StaffOnly><LeadsV2 /></StaffOnly>} />
              <Route path="/old-leads" element={<StaffOnly><Leads /></StaffOnly>} />
              <Route path="/leads/:id" element={<StaffOnly><LeadDetail /></StaffOnly>} />
              <Route path="/leads/:id/edit-pdf" element={<StaffOnly><EditPdf /></StaffOnly>} />
              <Route path="/sent-log" element={<StaffOnly><SentLog /></StaffOnly>} />
              <Route path="/analytics" element={<StaffOnly><Analytics /></StaffOnly>} />
              <Route path="/calls" element={<StaffOnly><Calls /></StaffOnly>} />
              <Route path="/training" element={<StaffOnly><Training /></StaffOnly>} />
              <Route path="/crew" element={<StaffOnly><Crew /></StaffOnly>} />
              <Route path="/crew/:id" element={<StaffOnly><CrewEmployee /></StaffOnly>} />
              <Route path="/accounting" element={<StaffOnly><Accounting /></StaffOnly>} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/my-schedule" element={<MySchedule />} />
              {/* Legacy bookmark redirect — old worker links pointed at /my-day */}
              <Route path="/my-day" element={<Navigate to="/my-schedule" replace />} />
              <Route path="/sops/job/:jobId" element={<JobSops />} />
              <Route path="/invoice-queue" element={<StaffOnly><InvoiceQueue /></StaffOnly>} />
              <Route path="/pricing" element={<StaffOnly><Pricing /></StaffOnly>} />
              <Route path="/ai-fence" element={<StaffOnly><AiFenceEstimation /></StaffOnly>} />
              <Route path="/settings" element={<StaffOnly><Settings /></StaffOnly>} />
              <Route path="/agents" element={<AdminOnly><Agents /></AdminOnly>} />
              <Route path="/internal" element={<FragnedOnly><Internal /></FragnedOnly>} />
            </Routes>
          </main>
        </div>
        {showCallList && <CallListPanel />}
        {/* Saturday / last-of-month CEO digest. Mounted at AppLayout so
            it fires on any page, not just Dashboard. Admin-only inside. */}
        <WrappedAutoPop />
      </div>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
      <Toaster position="top-right" richColors />
    </BrowserRouter>
  );
}
