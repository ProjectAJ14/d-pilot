import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useStore } from "./store";
import { BASE_PATH } from "./utils/base-path";
import { api } from "./utils/api-client";
import { loadAppConfig, loadConnections } from "./utils/app-config";
import { LoginScreen } from "./components/auth/login-screen";
import { TopBar } from "./components/layout/top-bar";
import { Sidebar } from "./components/layout/sidebar";
import { Footer } from "./components/layout/footer";
import { PwaUpdatePrompt } from "./components/layout/pwa-prompts";
import { QueryWorkspace } from "./components/query/query-workspace";
import { PhiConfigPanel } from "./components/phi/phi-config-panel";
import { PhiUnmaskModal } from "./components/phi/phi-unmask-modal";
import { ProfilePage } from "./components/pages/profile-page";
import { McpSetupPage } from "./components/pages/mcp-setup-page";
import { MCP_SETUP_PATH } from "./utils/mcp-setup";
import { SettingsPage } from "./components/pages/settings-page";
import { WriteWorkspace } from "./components/write/write-workspace";
import {
  RequestsPage,
  countActionRequired,
} from "./components/write/requests-page";
import { WriteRequestDetail } from "./components/write/write-request-detail";
import { SavedQueryLink } from "./components/query/saved-query-link";
import { ArtifactLink } from "./components/query/artifact-link";

function AuthenticatedApp() {
  const setSavedQueries = useStore((s) => s.setSavedQueries);
  const setArtifacts = useStore((s) => s.setArtifacts);
  const login = useStore((s) => s.login);
  const user = useStore((s) => s.user);

  useEffect(() => {
    loadConnections().catch(console.error);

    api.getSavedQueries().then(setSavedQueries).catch(console.error);
    api.getArtifacts().then(setArtifacts).catch(console.error);

    // Refresh the current user so newly-granted write/approve permissions and
    // roles appear without requiring a re-login.
    const token = useStore.getState().token;
    if (token) {
      api
        .me()
        .then((fresh) => login(token, fresh))
        .catch(() => {});
    }

    // Seed the "needs my action" badge for the Requests tab.
    if (user?.canWrite || user?.canApprove) {
      api
        .getWriteRequests()
        .then((all) =>
          useStore.getState().setActionRequiredCount(countActionRequired(all)),
        )
        .catch(() => {});
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar />
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Routes>
          <Route
            path="/"
            element={
              <>
                <Sidebar />
                <QueryWorkspace />
                <PhiConfigPanel />
              </>
            }
          />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path={MCP_SETUP_PATH} element={<McpSetupPage />} />
          <Route
            path="/write"
            element={
              user?.canWrite ? <WriteWorkspace /> : <Navigate to="/" replace />
            }
          />
          <Route
            path="/requests"
            element={
              user?.canWrite || user?.canApprove ? (
                <RequestsPage />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="/write-requests/:id" element={<WriteRequestDetail />} />
          <Route path="/saved-queries/:id" element={<SavedQueryLink />} />
          <Route path="/artifacts/:id" element={<ArtifactLink />} />
          <Route
            path="/settings"
            element={
              user?.isAdmin ? <SettingsPage /> : <Navigate to="/" replace />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <Footer />
      <PhiUnmaskModal />
    </div>
  );
}

export default function App() {
  const isAuthenticated = useStore((s) => s.isAuthenticated);
  useEffect(() => {
    loadAppConfig().catch(() => {});
  }, []);

  return (
    <>
      {/* Outside the auth branch so a pending update is offered on the login
          screen too, not just once someone is signed in. */}
      <PwaUpdatePrompt />
      {isAuthenticated ? (
        // basename, so every <Route path="/…"> below stays written as if the
        // app owned the domain root. React Router strips it from
        // useLocation().pathname and adds it back on navigation, which is why
        // the path comparisons in top-bar.tsx need no change.
        <BrowserRouter basename={BASE_PATH}>
          <AuthenticatedApp />
        </BrowserRouter>
      ) : (
        <LoginScreen />
      )}
    </>
  );
}
