import { QueryTabs } from "./query-tabs";
import { QueryEditor } from "./query-editor";
import { ResultsGrid } from "./results-grid";
import { useStore } from "../../store";

export function QueryWorkspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <QueryTabs />
      {activeTab && (
        <>
          <QueryEditor tab={activeTab} />
          <ResultsGrid tab={activeTab} />
        </>
      )}
    </div>
  );
}
