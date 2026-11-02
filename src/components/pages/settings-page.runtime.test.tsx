// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../utils/app-config";
import { mockApi, renderSettings, user } from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);
vi.mock("../../utils/app-config", () => ({
  loadAppConfig: vi.fn().mockResolvedValue(undefined),
  loadConnections: vi.fn().mockResolvedValue(undefined),
}));

const aiSettings = [
  {
    key: "AZURE_OPENAI_ENDPOINT",
    group: "ai",
    secret: false,
    source: "db",
    value: "https://old.example.com",
  },
  {
    key: "AZURE_OPENAI_KEY",
    group: "ai",
    secret: true,
    source: "db",
    set: true,
  },
  {
    key: "AZURE_OPENAI_INSECURE_TLS",
    group: "ai",
    secret: false,
    source: "env",
    value: "1",
  },
  { key: "OTHER_SECRET", group: "ai", secret: true, source: "default" },
];
const generalSettings = [
  {
    key: "APP_NAME",
    group: "branding",
    secret: false,
    source: "db",
    value: "D-Pilot",
  },
  {
    key: "LOGO_URL",
    group: "branding",
    secret: false,
    source: "default",
    value: null,
  },
  {
    key: "MAX_ROWS",
    group: "limits",
    secret: false,
    source: "env",
    value: "100",
    max: 10000,
  },
  {
    key: "SCHEMA_CACHE_TTL_HOURS",
    group: "limits",
    secret: false,
    source: "default",
    value: "24",
  },
  {
    key: "CUSTOM_LIMIT",
    group: "limits",
    secret: false,
    source: "default",
    value: "5",
  },
];
const all = [...aiSettings, ...generalSettings];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
  vi.mocked(loadAppConfig).mockResolvedValue(undefined);
  mockApi.getAiSettings.mockResolvedValue({ columnValues: false });
});

const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const input = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;

describe("Branding & limits form", () => {
  it("renders each setting with its source, hint and input kind", async () => {
    mockApi.getAppSettings.mockResolvedValue(all);
    renderSettings("general");
    expect(await screen.findByText("App name")).toBeTruthy();
    // Only the requested groups are shown.
    expect(screen.queryByText("Endpoint")).toBeNull();
    expect(screen.getByText("Top-bar logo on the light theme")).toBeTruthy();
    expect(input("Max rows per query").type).toBe("number");
    expect(input("Max rows per query").min).toBe("1");
    expect(screen.getByText("max 10,000")).toBeTruthy();
    expect(input("Schema cache TTL (hours)").min).toBe("0");
    expect(input("CUSTOM_LIMIT").type).toBe("text");
    expect(input("Logo URL").placeholder).toBe("Not set");
    expect(input("Logo URL").value).toBe("");
    expect(screen.getByText("DB")).toBeTruthy();
    expect(screen.getByText(".env")).toBeTruthy();
    expect(screen.getAllByText("default")).toHaveLength(3);
    expect(btn("Reset APP_NAME")).toBeTruthy();
    expect((btn(/^Save/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves only edited fields, then reloads branding", async () => {
    mockApi.getAppSettings.mockResolvedValue(all);
    renderSettings("general");
    const u = user();
    await screen.findByText("App name");
    await u.clear(input("App name"));
    await u.type(input("App name"), "Explorer");
    await u.clear(input("Max rows per query"));
    await u.type(input("Max rows per query"), "500");
    expect(btn("Save (2)")).toBeTruthy();

    mockApi.updateAppSettings.mockResolvedValue(all);
    await u.click(btn("Save (2)"));
    await waitFor(() =>
      expect(mockApi.updateAppSettings).toHaveBeenCalledWith({
        APP_NAME: "Explorer",
        MAX_ROWS: "500",
      }),
    );
    expect(await screen.findByText("Settings saved")).toBeTruthy();
    expect(loadAppConfig).toHaveBeenCalled();
    expect(input("App name").value).toBe("D-Pilot");
  });

  it("puts a field's validation error under it and clears it on edit", async () => {
    mockApi.getAppSettings.mockResolvedValue(all);
    renderSettings("general");
    const u = user();
    await screen.findByText("App name");
    await u.type(input("Max rows per query"), "0");
    mockApi.updateAppSettings.mockRejectedValueOnce(
      new Error("MAX_ROWS must be at most 10000"),
    );
    await u.click(btn("Save (1)"));
    expect(
      await screen.findByText("MAX_ROWS must be at most 10000"),
    ).toBeTruthy();
    // Editing another field keeps it; editing this one clears it.
    await u.type(input("App name"), "x");
    expect(screen.getByText("MAX_ROWS must be at most 10000")).toBeTruthy();
    await u.type(input("Max rows per query"), "1");
    expect(screen.queryByText("MAX_ROWS must be at most 10000")).toBeNull();

    // An error naming no field goes to the form alert; a bare string too.
    mockApi.updateAppSettings.mockRejectedValueOnce(new Error("server busy"));
    await u.click(btn(/^Save/));
    expect(await screen.findByText("server busy")).toBeTruthy();
    mockApi.updateAppSettings.mockRejectedValueOnce("plain failure");
    await u.click(btn(/^Save/));
    expect(await screen.findByText("plain failure")).toBeTruthy();

    await u.click(btn("Discard"));
    expect(input("Max rows per query").value).toBe("100");
    expect((btn(/^Save/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets a saved value, tolerating a failed config reload", async () => {
    mockApi.getAppSettings.mockResolvedValue(all);
    vi.mocked(loadAppConfig).mockRejectedValue(new Error("offline"));
    renderSettings("general");
    const u = user();
    await screen.findByText("App name");
    mockApi.resetAppSetting.mockResolvedValueOnce(all);
    await u.click(btn("Reset APP_NAME"));
    expect(await screen.findByText("APP_NAME reset")).toBeTruthy();
    expect(mockApi.resetAppSetting).toHaveBeenCalledWith("APP_NAME");

    mockApi.resetAppSetting.mockRejectedValueOnce(new Error("reset refused"));
    await u.click(btn("Reset APP_NAME"));
    expect(await screen.findByText("reset refused")).toBeTruthy();

    await u.type(input("App name"), "!");
    mockApi.updateAppSettings.mockResolvedValue(all);
    await u.click(btn("Save (1)"));
    expect(await screen.findByText("Settings saved")).toBeTruthy();
  });

  it("shows a load error with a working retry, and a skeleton meanwhile", async () => {
    mockApi.getAppSettings
      .mockRejectedValueOnce(new Error("settings down"))
      .mockReturnValueOnce(new Promise(() => {}));
    renderSettings("general");
    expect(await screen.findByText("settings down")).toBeTruthy();
    expect(screen.getByText("Could not load settings")).toBeTruthy();
    await user().click(btn("Retry"));
    await waitFor(() =>
      expect(mockApi.getAppSettings).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Could not load settings")).toBeNull();
    expect(screen.queryByText("App name")).toBeNull();
  });
});

describe("Azure OpenAI tab", () => {
  it("handles secrets: re-enter the key when its endpoint changes", async () => {
    mockApi.getAppSettings.mockResolvedValue(all);
    renderSettings("azure");
    const u = user();
    expect(await screen.findByText("Endpoint")).toBeTruthy();
    expect(input("API key").placeholder).toBe("•••• (unchanged)");
    expect(input("OTHER_SECRET").placeholder).toBe("Not set");
    expect(input("API key").required).toBe(false);
    // "1" from env counts as true: ticking state is not an edit.
    expect(input("Skip TLS verification").checked).toBe(true);
    expect(screen.queryByText(/fall back/)).toBeNull();

    await u.type(input("Endpoint"), "/v2");
    expect(input("API key").required).toBe(true);
    expect(
      screen.getByText(
        "Re-enter the key when changing the endpoint or TLS setting",
      ),
    ).toBeTruthy();
    await u.type(input("API key"), "new-key");
    expect(input("API key").required).toBe(false);

    await u.click(input("Skip TLS verification"));
    await u.click(input("Skip TLS verification"));
    expect(input("Skip TLS verification").checked).toBe(true);
    await u.click(input("Skip TLS verification"));
    await u.type(input("OTHER_SECRET"), "s3");
    mockApi.updateAppSettings.mockResolvedValue(all);
    await u.click(btn("Save (4)"));
    await waitFor(() =>
      expect(mockApi.updateAppSettings).toHaveBeenCalledWith({
        AZURE_OPENAI_ENDPOINT: "https://old.example.com/v2",
        AZURE_OPENAI_KEY: "new-key",
        AZURE_OPENAI_INSECURE_TLS: "false",
        OTHER_SECRET: "s3",
      }),
    );
  });

  it("toggles column values in the AI context", async () => {
    mockApi.getAppSettings.mockResolvedValue(aiSettings);
    renderSettings("azure");
    const u = user();
    const sw = () =>
      screen.getByLabelText(
        "Include column values in AI context",
      ) as HTMLInputElement;
    await waitFor(() => expect(sw().disabled).toBe(false));
    expect(sw().checked).toBe(false);
    mockApi.updateAiSettings.mockResolvedValueOnce({ columnValues: true });
    await u.click(sw());
    expect(await screen.findByText("AI settings updated")).toBeTruthy();
    expect(mockApi.updateAiSettings).toHaveBeenCalledWith({
      columnValues: true,
    });
    expect(sw().checked).toBe(true);
    mockApi.updateAiSettings.mockRejectedValueOnce(new Error("ai save failed"));
    await waitFor(() => expect(sw().disabled).toBe(false));
    await u.click(sw());
    expect(await screen.findByText("ai save failed")).toBeTruthy();
  });

  it("reports when AI settings cannot load", async () => {
    mockApi.getAppSettings.mockResolvedValue(aiSettings);
    mockApi.getAiSettings.mockRejectedValue(new Error("ai settings down"));
    renderSettings("azure");
    expect(await screen.findByText("ai settings down")).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Include column values in AI context",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the connection test result", async () => {
    mockApi.getAppSettings.mockResolvedValue(aiSettings);
    renderSettings("azure");
    const u = user();
    const test = () => btn(/Test Connect to Azure OpenAI/);

    mockApi.testAzureConnection.mockResolvedValueOnce({
      success: true,
      message: "Connected",
      endpoint: "https://ai.example.com",
      deployment: "gpt",
      model: "gpt-4o",
    });
    await u.click(test());
    expect(await screen.findByText("SUCCESS")).toBeTruthy();
    expect(screen.getByText("endpoint: https://ai.example.com")).toBeTruthy();
    expect(screen.getByText("deployment: gpt")).toBeTruthy();
    expect(screen.getByText("model: gpt-4o")).toBeTruthy();

    mockApi.testAzureConnection.mockResolvedValueOnce({
      success: true,
      message: "Endpoint only",
      endpoint: "https://ai.example.com",
    });
    await u.click(test());
    expect(await screen.findByText("Endpoint only")).toBeTruthy();
    expect(screen.queryByText(/deployment:/)).toBeNull();
    expect(screen.queryByText(/model:/)).toBeNull();

    mockApi.testAzureConnection.mockResolvedValueOnce({
      success: false,
      message: "Bad key",
    });
    await u.click(test());
    expect(await screen.findByText("Bad key")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();

    mockApi.testAzureConnection.mockRejectedValueOnce(new Error("timeout"));
    await u.click(test());
    expect(await screen.findByText("timeout")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
  });
});
