import { useStore } from "../store";
import { api } from "./api-client";
import { DEFAULT_COPY_FORMATS } from "./data-extractors";

/**
 * (Re)load the public `/api/config` into the store and apply the branding that
 * lives outside React (favicon, iOS home-screen title). Called on boot and again
 * after an admin saves settings or connections, so changes show without a reload.
 */
export async function loadAppConfig(): Promise<void> {
  const cfg = await api.getConfig();
  // An older server may not send copyFormats — fall back to code defaults.
  useStore.getState().setConfig({
    ...cfg,
    copyFormats: cfg.copyFormats?.length
      ? cfg.copyFormats
      : DEFAULT_COPY_FORMATS,
  });
  if (cfg.faviconUrl) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = cfg.faviconUrl;
  }
  // iOS takes the home-screen name from this tag rather than the
  // manifest, so branding has to be applied to it at runtime too.
  if (cfg.appName) {
    document
      .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')
      ?.setAttribute("content", cfg.appName);
  }
}

/** Reload the connection list, keeping the active one if it still exists. */
export async function loadConnections(): Promise<void> {
  const conns = await api.getConnections();
  const { setConnections, activeConnectionId, setActiveConnection } =
    useStore.getState();
  setConnections(conns);
  if (conns.length > 0 && !conns.some((c) => c.id === activeConnectionId)) {
    setActiveConnection(conns[0].id);
  }
}
