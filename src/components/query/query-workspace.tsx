import { useState, useRef, useCallback, useEffect } from "react";
import { QueryTabs } from "./query-tabs";
import { QueryEditor } from "./query-editor";
import { ResultsGrid } from "./results-grid";
import { useStore } from "../../store";

const DEFAULT_HEIGHT = 150;
const MIN_EDITOR_HEIGHT = 100;
const COMPACT_HEIGHT = 150;
const EXPANDED_HEIGHT = 400;

export function QueryWorkspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const containerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState(DEFAULT_HEIGHT);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const expanded = editorHeight > COMPACT_HEIGHT;

  const toggleEditorHeight = useCallback(() => {
    setEditorHeight((h) => (h > COMPACT_HEIGHT ? COMPACT_HEIGHT : EXPANDED_HEIGHT));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startY.current = e.clientY;
    startHeight.current = editorHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [editorHeight]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const maxHeight = containerRef.current.getBoundingClientRect().height * 0.7;
      const delta = e.clientY - startY.current;
      setEditorHeight(Math.min(maxHeight, Math.max(MIN_EDITOR_HEIGHT, startHeight.current + delta)));
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div
      ref={containerRef}
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
          <QueryEditor
            tab={activeTab}
            height={editorHeight}
            expanded={expanded}
            onToggleHeight={toggleEditorHeight}
          />
          {/* Invisible drag handle — only the knob is visible */}
          <div
            onMouseDown={handleMouseDown}
            style={{
              height: 8,
              cursor: "row-resize",
              position: "relative",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: 32,
                height: 4,
                borderRadius: 2,
                background: "rgba(0,0,0,0.15)",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent, #1f9196)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.15)")}
            />
          </div>
          <ResultsGrid tab={activeTab} />
        </>
      )}
    </div>
  );
}
