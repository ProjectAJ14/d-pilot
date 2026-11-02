// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { api } from "../../utils/api-client";
import type { ConnectionInfo, WriteRequest } from "../../types";
import { WriteWorkspace } from "./write-workspace";

type ComposerProps = {
  connections: ConnectionInfo[];
  directEnvs: string[];
  writeModeEnabled: boolean;
  onSubmit: (p: Record<string, unknown>) => Promise<WriteRequest>;
  onSave: (p: Record<string, unknown>) => Promise<WriteRequest>;
  onSubmitted: (wr: WriteRequest) => void;
};

const payload = {
  title: "Fix order",
  description: "typo",
  connectionId: "c1",
  selectSql: "SELECT * FROM orders WHERE id=1",
  writeSql: "UPDATE orders SET a=1 WHERE id=1",
  noTransaction: false,
};

vi.mock("./write-composer", () => ({
  WriteComposer: (p: ComposerProps) => (
    <div>
      <span data-testid="props">
        {JSON.stringify({
          n: p.connections.length,
          direct: p.directEnvs,
          writeMode: p.writeModeEnabled,
        })}
      </span>
      <button onClick={() => p.onSubmit(payload).then(p.onSubmitted)}>
        submit
      </button>
      <button onClick={() => p.onSave(payload)}>save</button>
    </div>
  ),
}));

vi.mock("../../utils/api-client", async (orig) => {
  const mod = await orig<typeof import("../../utils/api-client")>();
  return {
    ...mod,
    api: {
      getWritableConnections: vi.fn(),
      getWritePolicy: vi.fn(),
      createWriteRequest: vi.fn(),
    },
  };
});

const m = vi.mocked(api);

beforeEach(() => vi.clearAllMocks());

function renderWs() {
  return renderUi(
    <Routes>
      <Route path="/write" element={<WriteWorkspace />} />
      <Route path="/write-requests/:id" element={<div>request page</div>} />
    </Routes>,
    { route: "/write" },
  );
}

describe("WriteWorkspace", () => {
  it("loads connections and policy into the composer, and submits then navigates", async () => {
    m.getWritableConnections.mockResolvedValue([
      { id: "c1", name: "app_core", env: "QA", type: "postgres" },
    ]);
    m.getWritePolicy.mockResolvedValue({
      directEnvs: ["DEV"],
      writeModeEnabled: false,
    } as never);
    m.createWriteRequest.mockResolvedValue({ id: "wr-9" } as WriteRequest);
    renderWs();
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("props").textContent!)).toEqual({
        n: 1,
        direct: ["DEV"],
        writeMode: false,
      }),
    );
    expect(screen.queryByText(/do not have write access/)).toBeNull();

    fireEvent.click(screen.getByText("save"));
    expect(m.createWriteRequest).toHaveBeenLastCalledWith({
      ...payload,
      draft: true,
    });

    fireEvent.click(screen.getByText("submit"));
    expect(m.createWriteRequest).toHaveBeenLastCalledWith(payload);
    await waitFor(() => expect(screen.getByText("request page")).toBeTruthy());
  });

  it("explains missing write access and survives failed loads", async () => {
    m.getWritableConnections.mockRejectedValue(new Error("nope"));
    m.getWritePolicy.mockRejectedValue(new Error("policy down"));
    renderWs();
    expect(screen.getByText(/do not have write access/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
    expect(JSON.parse(screen.getByTestId("props").textContent!)).toEqual({
      n: 0,
      direct: [],
      writeMode: true,
    });
  });
});
