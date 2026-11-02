// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { copyToClipboard } from "../../utils/clipboard";
import { renderUi } from "../../utils/dom.testing";
import { MASKED_AUTH, basicAuthValue, setupSteps } from "../../utils/mcp-setup";
import { McpSetupPage } from "./mcp-setup-page";

vi.mock("../../utils/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("../../utils/mcp-setup", async (orig) => {
  const real = await orig<typeof import("../../utils/mcp-setup")>();
  return { ...real, setupSteps: vi.fn(real.setupSteps) };
});
const copy = vi.mocked(copyToClipboard);

const mount = () =>
  renderUi(
    <Routes>
      <Route path="/docs/mcp" element={<McpSetupPage />} />
      <Route path="/" element={<div>home</div>} />
    </Routes>,
    { route: "/docs/mcp" },
  );

const panel = () => screen.getByRole("tabpanel");
const codeBlocks = () =>
  Array.from(panel().querySelectorAll("pre")).map((p) => p.textContent!);

beforeEach(() => {
  copy.mockClear();
  useStore.setState({
    config: { ...useStore.getState().config, appName: "D-Pilot" },
    user: { username: "alice", email: "alice@example.com" } as never,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { userAgentData?: unknown }).userAgentData;
});

describe("McpSetupPage", () => {
  it("prefills the username, masks the credential and disables copy until a password is typed", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh)",
    );
    const user = userEvent.setup({ delay: null });
    mount();
    expect(screen.getByLabelText("Username")).toHaveProperty("value", "alice");
    expect(within(panel()).getByText(/Run these in a terminal/)).toBeTruthy();
    expect(codeBlocks().join("\n")).toContain(MASKED_AUTH);
    expect(codeBlocks().join("\n")).toContain(
      `${window.location.origin}/mcp-bridge.mjs`,
    );

    // The step without a credential copies straight away.
    const download = screen.getByRole("button", { name: "Copy step 1" });
    await user.click(download);
    expect(copy).toHaveBeenCalledWith(
      codeBlocks()[0],
      "step 1",
      codeBlocks()[0],
    );

    const locked = screen.getByRole("button", {
      name: "Enter the password to copy",
    });
    expect(locked).toHaveProperty("disabled", true);

    await user.type(screen.getByLabelText("Password"), "s3cret");
    const step2 = screen.getByRole("button", { name: "Copy step 2" });
    await user.click(step2);
    const [copied, label, shown] = copy.mock.calls.at(-1)!;
    expect(label).toBe("step 2");
    // The screen keeps showing the mask; only the copied text has the secret.
    expect(shown).toContain(MASKED_AUTH);
    expect(copied).toContain(basicAuthValue("alice", "s3cret"));
    expect(screen.queryByText(/s3cret/)).toBeNull();
    // Steps with notes show them.
    expect(
      within(panel()).getByText(/Expect d-pilot to show as Connected/),
    ).toBeTruthy();
  });

  it("says what is missing when both username and password are blank", async () => {
    const user = userEvent.setup({ delay: null });
    useStore.setState({ user: null });
    mount();
    expect(screen.getByLabelText("Username")).toHaveProperty("value", "");
    expect(
      screen.getByRole("button", {
        name: "Enter the username and password to copy",
      }),
    ).toBeTruthy();
    // Whitespace-only usernames don't count.
    await user.type(screen.getByLabelText("Username"), "   ");
    await user.type(screen.getByLabelText("Password"), "pw");
    expect(
      screen.getByRole("button", { name: "Enter the username to copy" }),
    ).toBeTruthy();
  });

  it("detects Windows from the client hint and switches OS and client tabs", async () => {
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: "Windows" },
      configurable: true,
    });
    const user = userEvent.setup({ delay: null });
    mount();
    expect(within(panel()).getByText(/Run these in PowerShell/)).toBeTruthy();
    expect(codeBlocks()[0]).toMatch(/Invoke-WebRequest|\$env|iwr/i);

    await user.click(screen.getByText("macOS / Linux"));
    expect(within(panel()).getByText(/Run these in a terminal/)).toBeTruthy();

    await user.click(
      screen.getByRole("tab", { name: "Claude Code, direct HTTP" }),
    );
    expect(panel().textContent).toContain("No Node needed");
    expect(codeBlocks().join("\n")).toContain("--transport http");

    await user.click(screen.getByRole("tab", { name: "Claude Desktop" }));
    expect(panel().textContent).toContain("--install-desktop");
    // The "quit Desktop" step is a note with no code block.
    expect(panel().querySelectorAll("li").length).toBeGreaterThan(
      codeBlocks().length,
    );
  });

  it("never copies a step whose copy text wasn't built", async () => {
    vi.mocked(setupSteps).mockImplementation(() => [
      { title: "Custom", code: "echo hi" },
      { title: "Bare step" },
    ]);
    mount();
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    const btn = within(panel()).getByRole("button", { name: /Enter/ });
    expect(btn).toHaveProperty("disabled", true);
    expect(copy).not.toHaveBeenCalled();
    // A step with neither code nor note is just its title.
    const bare = within(panel()).getByText("Bare step").closest("li")!;
    expect(bare.querySelector("pre")).toBeNull();
  });

  it("goes back to the query workspace", async () => {
    mount();
    await userEvent.click(screen.getByText("Back to queries"));
    expect(await screen.findByText("home")).toBeTruthy();
  });
});
