// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { downloadTextFile } from "../../utils/download-file";
import {
  dialog,
  mockApi,
  renderSettings,
  setEnvironments,
  user,
} from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);
vi.mock("../../utils/download-file", () => ({ downloadTextFile: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
  setEnvironments(["PROD", "QA", "DEV"]);
});

const btn = (name: string | RegExp) => screen.getByRole("button", { name });

describe("Write mode tab", () => {
  it("toggles write mode and direct-write envs, refusing production", async () => {
    mockApi.getWritePolicy.mockResolvedValue({
      writeModeEnabled: true,
      directEnvs: ["DEV", "LEGACY"],
    });
    renderSettings("write");
    const u = user();
    await screen.findByText("Direct-write Environments");
    expect(screen.getByText("(no connection)")).toBeTruthy();

    await u.click(btn("PROD"));
    expect(await screen.findByText("Not allowed for PROD")).toBeTruthy();
    expect(mockApi.updateWritePolicy).not.toHaveBeenCalled();

    mockApi.updateWritePolicy.mockResolvedValueOnce({
      writeModeEnabled: true,
      directEnvs: ["DEV", "LEGACY", "QA"],
    });
    await u.click(btn("QA"));
    expect(mockApi.updateWritePolicy).toHaveBeenLastCalledWith({
      directEnvs: ["DEV", "LEGACY", "QA"],
    });
    expect(await screen.findByText("Write policy updated")).toBeTruthy();

    mockApi.updateWritePolicy.mockResolvedValueOnce({
      writeModeEnabled: true,
      directEnvs: ["LEGACY", "QA"],
    });
    await waitFor(() =>
      expect((btn("DEV") as HTMLButtonElement).disabled).toBe(false),
    );
    await u.click(btn("DEV"));
    expect(mockApi.updateWritePolicy).toHaveBeenLastCalledWith({
      directEnvs: ["LEGACY", "QA"],
    });

    // A failed save reloads the policy from the server.
    mockApi.updateWritePolicy.mockRejectedValueOnce(new Error("policy locked"));
    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    await u.click(screen.getByRole("switch"));
    expect(mockApi.updateWritePolicy).toHaveBeenLastCalledWith({
      writeModeEnabled: false,
    });
    expect(await screen.findByText("policy locked")).toBeTruthy();
    await waitFor(() =>
      expect(mockApi.getWritePolicy).toHaveBeenCalledTimes(2),
    );
  });

  it("reports a failed policy load", async () => {
    mockApi.getWritePolicy.mockRejectedValue(new Error("no policy"));
    renderSettings("write");
    expect(await screen.findByText("no policy")).toBeTruthy();
  });
});

const rules = [
  {
    id: "r1",
    pattern: "*email*",
    maskingType: "FULL",
    alwaysMasked: true,
  },
  {
    id: "r2",
    pattern: "*account_code*",
    maskingType: "HASH",
    alwaysMasked: false,
    database: "app_core",
  },
  {
    id: "r3",
    pattern: "*notes*",
    maskingType: "REDACT",
    alwaysMasked: false,
    table: "orders",
  },
];

function openPhi(list: unknown[] = rules, masked = ["PROD", "OLD"]) {
  mockApi.getPhiRules.mockResolvedValue(list);
  mockApi.getMaskedEnvironments.mockResolvedValue({ environments: masked });
  renderSettings("phi");
}

describe("PHI tab", () => {
  it("lists rules with icon, scope and lock state", async () => {
    openPhi();
    expect(await screen.findByText("3 tokenization rules")).toBeTruthy();
    expect(screen.getByText("✉️")).toBeTruthy();
    expect(screen.getAllByText("🔐")).toHaveLength(2);
    expect(screen.getByText("app_core.*")).toBeTruthy();
    expect(screen.getByText("*.orders")).toBeTruthy();
    expect(screen.getByText("All databases")).toBeTruthy();
    expect(screen.getByText("LOCKED")).toBeTruthy();
    expect(await screen.findByText("(no connection)")).toBeTruthy();
  });

  it("shows the empty state and reports load failures", async () => {
    mockApi.getPhiRules.mockRejectedValueOnce(new Error("rules down"));
    mockApi.getMaskedEnvironments.mockRejectedValue(new Error("envs down"));
    renderSettings("phi");
    expect(await screen.findByText("rules down")).toBeTruthy();
    expect(await screen.findByText("envs down")).toBeTruthy();
    expect(screen.getByText("No PHI rules configured")).toBeTruthy();
    expect((btn(/Delete All/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles masked environments, keeping production locked", async () => {
    openPhi(rules, ["PROD"]);
    const u = user();
    await screen.findByText("3 tokenization rules");
    await waitFor(() =>
      expect(mockApi.getMaskedEnvironments).toHaveBeenCalled(),
    );

    await u.click(btn("PROD"));
    expect(await screen.findByText("PROD is always tokenized")).toBeTruthy();

    mockApi.updateMaskedEnvironments.mockResolvedValue({});
    await u.click(btn("QA"));
    expect(mockApi.updateMaskedEnvironments).toHaveBeenLastCalledWith([
      "PROD",
      "QA",
    ]);
    expect(await screen.findByText("Masked environments updated")).toBeTruthy();
    expect(useStore.getState().config.phiMaskedEnvironments).toEqual([
      "PROD",
      "QA",
    ]);

    await waitFor(() =>
      expect((btn("QA") as HTMLButtonElement).disabled).toBe(false),
    );
    await u.click(btn("QA"));
    expect(mockApi.updateMaskedEnvironments).toHaveBeenLastCalledWith(["PROD"]);

    mockApi.updateMaskedEnvironments.mockRejectedValueOnce(new Error("nope"));
    await waitFor(() =>
      expect((btn("DEV") as HTMLButtonElement).disabled).toBe(false),
    );
    await u.click(btn("DEV"));
    expect(await screen.findByText("nope")).toBeTruthy();
  });

  it("deletes a single rule", async () => {
    openPhi();
    const u = user();
    await screen.findByText("3 tokenization rules");
    const row = screen.getByText("account_code").closest("tr")!;
    await u.click(within(row).getByRole("button"));
    mockApi.deletePhiRule.mockRejectedValueOnce(new Error("in use"));
    await u.click(
      (await dialog()).getByRole("button", { name: "Delete Rule" }),
    );
    expect(await screen.findByText("in use")).toBeTruthy();
    mockApi.deletePhiRule.mockResolvedValue({});
    await u.click(
      (await dialog()).getByRole("button", { name: "Delete Rule" }),
    );
    expect(await screen.findByText("Rule deleted")).toBeTruthy();
    expect(mockApi.deletePhiRule).toHaveBeenCalledWith("r2");
    expect(mockApi.getPhiRules).toHaveBeenCalledTimes(2);

    await u.click(within(row).getByRole("button"));
    await u.click((await dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Escape closes it too.
    await u.click(within(row).getByRole("button"));
    await dialog();
    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("deletes all rules, optionally including locked ones", async () => {
    openPhi();
    const u = user();
    await screen.findByText("3 tokenization rules");
    await u.click(btn(/Delete All/));
    let d = await dialog();
    expect(d.getByText(/of 3 tokenization/).textContent).toContain(
      "Delete 2 of 3",
    );
    await u.click(
      d.getByLabelText("Also delete 1 locked (always-masked) rule"),
    );
    expect(d.getByText(/No rules will remain/)).toBeTruthy();

    mockApi.deleteAllPhiRules.mockRejectedValueOnce(new Error("busy"));
    await u.click(d.getByRole("button", { name: "Delete All Rules" }));
    expect(await screen.findByText("busy")).toBeTruthy();

    mockApi.deleteAllPhiRules.mockResolvedValueOnce({ deleted: 3, kept: 0 });
    await u.click(d.getByRole("button", { name: "Delete All Rules" }));
    expect(await screen.findByText("3 rules deleted")).toBeTruthy();
    expect(mockApi.deleteAllPhiRules).toHaveBeenLastCalledWith(true);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await u.click(btn(/Delete All/));
    d = await dialog();
    mockApi.deleteAllPhiRules.mockResolvedValueOnce({ deleted: 1, kept: 1 });
    await u.click(d.getByRole("button", { name: "Delete All Rules" }));
    expect(await screen.findByText("1 rule deleted")).toBeTruthy();
    expect(screen.getByText("1 locked rule kept")).toBeTruthy();
    expect(mockApi.deleteAllPhiRules).toHaveBeenLastCalledWith(false);
  });

  it("pluralises kept locked rules and disables delete when all are locked", async () => {
    const locked = [rules[0], { ...rules[0], id: "r9", pattern: "*phone*" }];
    openPhi(locked);
    const u = user();
    await screen.findByText("2 tokenization rules");
    await u.click(btn(/Delete All/));
    const d = await dialog();
    expect(
      (d.getByRole("button", { name: "Delete All Rules" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await u.click(
      d.getByLabelText("Also delete 2 locked (always-masked) rules"),
    );
    mockApi.deleteAllPhiRules.mockResolvedValueOnce({ deleted: 0, kept: 2 });
    await u.click(
      d.getByLabelText("Also delete 2 locked (always-masked) rules"),
    );
    await u.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reports kept rules in the plural", async () => {
    openPhi([rules[1]]);
    const u = user();
    await screen.findByText("1 tokenization rule");
    await u.click(btn(/Delete All/));
    const d = await dialog();
    expect(d.getByText(/No rules will remain/)).toBeTruthy();
    mockApi.deleteAllPhiRules.mockResolvedValueOnce({ deleted: 1, kept: 2 });
    await u.click(d.getByRole("button", { name: "Delete All Rules" }));
    expect(await screen.findByText("2 locked rules kept")).toBeTruthy();
  });

  it("exports rules as a dated CSV", async () => {
    openPhi();
    const u = user();
    await screen.findByText("3 tokenization rules");
    mockApi.exportPhiRules.mockResolvedValueOnce("pattern\n*email*");
    await u.click(btn(/Export CSV/));
    await waitFor(() =>
      expect(downloadTextFile).toHaveBeenCalledWith(
        expect.stringMatching(/^phi-rules-\d{4}-\d{2}-\d{2}\.csv$/),
        "pattern\n*email*",
      ),
    );
    mockApi.exportPhiRules.mockRejectedValueOnce(new Error("export failed"));
    await u.click(btn(/Export CSV/));
    expect(await screen.findByText("export failed")).toBeTruthy();
  });

  it("imports a CSV and summarises the result", async () => {
    openPhi();
    const u = user();
    await screen.findByText("3 tokenization rules");
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = () => new File(["pattern\n*ssn*"], "rules.csv");

    mockApi.importPhiRules.mockResolvedValueOnce({
      imported: 1,
      updated: 2,
      skipped: 3,
    });
    await u.upload(input, file());
    expect(await screen.findByText("Rules imported")).toBeTruthy();
    expect(
      screen.getByText("1 added, 2 updated, 3 identical skipped"),
    ).toBeTruthy();
    expect(mockApi.importPhiRules).toHaveBeenCalledWith("pattern\n*ssn*");

    mockApi.importPhiRules.mockResolvedValueOnce({
      imported: 0,
      updated: 0,
      skipped: 0,
    });
    await u.upload(input, file());
    expect(await screen.findByText("No changes")).toBeTruthy();
    expect(screen.getByText("0 added")).toBeTruthy();

    mockApi.importPhiRules.mockRejectedValueOnce(new Error("bad header"));
    await u.upload(input, file());
    expect(await screen.findByText("Import failed")).toBeTruthy();

    // Cancelling the picker hands back no file — nothing is sent.
    const calls = mockApi.importPhiRules.mock.calls.length;
    fireEvent.change(input, { target: { files: [] } });
    expect(mockApi.importPhiRules).toHaveBeenCalledTimes(calls);
  });

  it("adds a rule with an optional scope", async () => {
    openPhi([]);
    const u = user();
    await screen.findByText("0 tokenization rules");
    await u.click(btn(/Add Rule/));
    const d = await dialog();
    expect(
      (d.getByRole("button", { name: "Create Rule" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await u.type(d.getByLabelText("Column Pattern"), "  *ssn*  ");
    await u.click(
      d.getByLabelText("Always masked (cannot be unmasked by anyone)"),
    );
    await u.click(d.getByLabelText("Masking Type"));
    await u.click(
      (await screen.findAllByRole("option", { name: /HASH/, hidden: true }))[0],
    );
    mockApi.createPhiRule.mockRejectedValueOnce(new Error("duplicate"));
    await u.click(d.getByRole("button", { name: "Create Rule" }));
    expect(await screen.findByText("duplicate")).toBeTruthy();
    expect(mockApi.createPhiRule).toHaveBeenLastCalledWith({
      pattern: "*ssn*",
      maskingType: "HASH",
      alwaysMasked: true,
      database: undefined,
      table: undefined,
    });

    // Deselecting the type falls back to PARTIAL.
    await u.click(d.getByLabelText("Masking Type"));
    await u.click(
      (await screen.findAllByRole("option", { name: /HASH/, hidden: true }))[0],
    );
    await u.type(d.getByLabelText("Database (optional)"), "app_core");
    await u.type(d.getByLabelText("Table (optional)"), "customers");
    mockApi.createPhiRule.mockResolvedValue({});
    await u.click(d.getByRole("button", { name: "Create Rule" }));
    expect(await screen.findByText("PHI rule created")).toBeTruthy();
    expect(mockApi.createPhiRule).toHaveBeenLastCalledWith({
      pattern: "*ssn*",
      maskingType: "PARTIAL",
      alwaysMasked: true,
      database: "app_core",
      table: "customers",
    });
    expect(mockApi.getPhiRules).toHaveBeenCalledTimes(2);

    await u.click(btn(/Add Rule/));
    await u.click((await dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
