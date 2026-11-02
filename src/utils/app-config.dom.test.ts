// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ cfg: {} as Record<string, unknown> }));
vi.mock("./api-client", () => ({ api: { getConfig: async () => h.cfg } }));

const { useStore } = await import("../store");
const { loadAppConfig } = await import("./app-config");

const cfg = (over: Record<string, unknown>) => ({
  ...useStore.getState().config,
  appName: "D-Pilot",
  faviconUrl: "",
  loginTagline: "",
  ...over,
});

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="apple-mobile-web-app-title" content="old">';
});

describe("loadAppConfig", () => {
  it("stores the config and applies favicon, title and iOS name", async () => {
    h.cfg = cfg({
      appName: "Acme SQL",
      faviconUrl: "/fav.png",
      loginTagline: "Read-first",
    });
    await loadAppConfig();
    expect(useStore.getState().config.appName).toBe("Acme SQL");
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    expect(link.getAttribute("href")).toBe("/fav.png");
    expect(document.title).toBe("Acme SQL — Read-first");
    expect(
      document
        .querySelector('meta[name="apple-mobile-web-app-title"]')!
        .getAttribute("content"),
    ).toBe("Acme SQL");
  });

  it("reuses an existing icon link instead of adding a second", async () => {
    document.head.innerHTML += '<link rel="icon" href="/old.ico">';
    h.cfg = cfg({ faviconUrl: "/new.ico" });
    await loadAppConfig();
    const links = document.querySelectorAll('link[rel="icon"]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/new.ico");
  });

  it("leaves favicon and iOS name alone when they are not configured", async () => {
    h.cfg = cfg({ appName: "" });
    await loadAppConfig();
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
    expect(
      document
        .querySelector('meta[name="apple-mobile-web-app-title"]')!
        .getAttribute("content"),
    ).toBe("old");
    expect(document.title).toBe("");
  });
});
