import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useStore } from "./store";
import { api } from "./utils/api-client";
import { LoginScreen } from "./components/auth/login-screen";
import { TopBar } from "./components/layout/top-bar";
import { Sidebar } from "./components/layout/sidebar";
import { QueryWorkspace } from "./components/query/query-workspace";
import { PhiConfigPanel } from "./components/phi/phi-config-panel";
import { PhiUnmaskModal } from "./components/phi/phi-unmask-modal";
import { ProfilePage } from "./components/pages/profile-page";
import { SettingsPage } from "./components/pages/settings-page";

function AuthenticatedApp() {
  const setConnections = useStore((s) => s.setConnections);
  const setSavedQueries = useStore((s) => s.setSavedQueries);
  const setActiveConnection = useStore((s) => s.setActiveConnection);
  const user = useStore((s) => s.user);

  useEffect(() => {
    api
      .getConnections()
      .then((conns) => {
        setConnections(conns);
        if (conns.length > 0) {
          setActiveConnection(conns[0].id);
        }
      })
      .catch(console.error);

    api.getSavedQueries().then(setSavedQueries).catch(console.error);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
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
          <Route
            path="/settings"
            element={
              user?.isAdmin ? <SettingsPage /> : <Navigate to="/" replace />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <PhiUnmaskModal />
    </div>
  );
}

export default function App() {
  const isAuthenticated = useStore((s) => s.isAuthenticated);
  const setConfig = useStore((s) => s.setConfig);

  useEffect(() => {
    api.getConfig().then((cfg) => {
      setConfig(cfg);
      if (cfg.faviconUrl) {
        let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (!link) {
          link = document.createElement("link");
          link.rel = "icon";
          document.head.appendChild(link);
        }
        link.href = cfg.faviconUrl;
      }
    }).catch(() => {});
  }, []);

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return (
    <BrowserRouter>
      <AuthenticatedApp />
    </BrowserRouter>
  );
}
