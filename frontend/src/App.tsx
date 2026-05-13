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
import Crew from "@/pages/Crew";
import CrewEmployee from "@/pages/CrewEmployee";
import CalendarPage from "@/pages/Calendar";
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

// Workers see only /calendar — any other URL bounces back.
function StaffOnly({ children }: { children: React.ReactNode }) {
  const u = getCurrentUser();
  if (u?.role === "worker") return <Navigate to="/calendar" replace />;
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
              <Route path="/crew" element={<StaffOnly><Crew /></StaffOnly>} />
              <Route path="/crew/:id" element={<StaffOnly><CrewEmployee /></StaffOnly>} />
              <Route path="/accounting" element={<StaffOnly><Accounting /></StaffOnly>} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/pricing" element={<StaffOnly><Pricing /></StaffOnly>} />
              <Route path="/ai-fence" element={<StaffOnly><AiFenceEstimation /></StaffOnly>} />
              <Route path="/settings" element={<StaffOnly><Settings /></StaffOnly>} />
              <Route path="/agents" element={<AdminOnly><Agents /></AdminOnly>} />
              <Route path="/internal" element={<FragnedOnly><Internal /></FragnedOnly>} />
            </Routes>
          </main>
        </div>
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
