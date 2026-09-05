import { useState } from "react";
import { Popover, Text, ActionIcon } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { copyToClipboard } from "../../utils/clipboard";

interface Props {
  /** The column that holds the foreign key. */
  column: string;
  /** Target of the constraint, e.g. `customers.id` or `geo.regions.id`. May be
   *  absent when introspection only knew the column *is* a FK. */
  references?: string;
  size?: number;
}

/**
 * Solid "FK" chip. Click opens the constraint details — the schema sidebar and
 * the results grid both use it so a foreign key looks the same everywhere.
 */
export function FkBadge({ column, references, size = 9 }: Props) {
  const [open, setOpen] = useState(false);
  const parts = references ? references.split(".") : [];
  const targetColumn = parts.length > 1 ? parts[parts.length - 1] : null;
  const targetTable = parts.length > 1 ? parts.slice(0, -1).join(".") : null;

  return (
    <Popover opened={open} onChange={setOpen} withArrow shadow="md" position="bottom" width={260}>
      <Popover.Target>
        <span
          role="button"
          tabIndex={0}
          title="Foreign key — click for details"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              setOpen((o) => !o);
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            // Reserved semantics: the FK chip is brand accent, not the PHI
            // token teal — they resolve to the same hue today, see the design
            // skill's note on that collision.
            background: "var(--accent-text)",
            color: "var(--surface)",
            borderRadius: 3,
            padding: "1px 4px",
            fontSize: size,
            fontWeight: 700,
            letterSpacing: 0.4,
            lineHeight: 1.4,
            fontFamily: "IBM Plex Mono, monospace",
            cursor: "pointer",
            flexShrink: 0,
            userSelect: "none",
          }}
        >
          FK
        </span>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()} p="xs">
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.5 }}>
          Foreign key
        </Text>
        <FkRow label="Column" value={column} />
        {targetTable && <FkRow label="References table" value={targetTable} />}
        {targetColumn && <FkRow label="References column" value={targetColumn} />}
        {references && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
            <Text size="xs" ff="monospace" style={{ flex: 1, wordBreak: "break-all" }}>
              {column} &rarr; {references}
            </Text>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="Copy reference"
              onClick={() => copyToClipboard(references, "reference")}
            >
              <IconCopy size={12} />
            </ActionIcon>
          </div>
        )}
        {!references && (
          <Text size="xs" c="dimmed" mt={6}>
            Target unknown — the schema cache has no reference for this constraint.
          </Text>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

function FkRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      <Text size="xs" c="dimmed" style={{ minWidth: 108 }}>
        {label}
      </Text>
      <Text size="xs" ff="monospace" style={{ wordBreak: "break-all" }}>
        {value}
      </Text>
    </div>
  );
}
