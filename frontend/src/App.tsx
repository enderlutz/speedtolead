import { useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { isAuthenticated } from "@/lib/api";
import Sidebar, { MobileHeader } from "@/components/Sidebar";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Leads from "@/pages/Leads";
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
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
    location.pathname.startsWith("/approve/");

  if (isPublic) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/approve/:token" element={<QuickApprove />} />
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
              <Route path="/" element={<Dashboard />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/leads/:id/edit-pdf" element={<EditPdf />} />
              <Route path="/sent-log" element={<SentLog />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/calls" element={<Calls />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/ai-fence" element={<AiFenceEstimation />} />
              <Route path="/settings" element={<Settings />} />
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
