/**
 * Artifacts — shareable documents that pair prose with runnable read queries.
 *
 * Same visibility model as saved queries (shared by default, author-only edits),
 * and the same deep-link shape: `/artifacts/:id` opens the document as a tab for
 * anyone who can log in. What an artifact never holds is result rows — only the
 * queries — so a viewer's results always come back through their own capability
 * checks, PHI masking and audit entries via `/api/query/execute`. That is the
 * whole reason blocks store SQL instead of a rendered snapshot.
 *
 * Blocks are structured: prose and queries are separate, so a query is always a
 * query the reader can run rather than a fenced string in a wall of text. Text
 * blocks are markdown, rendered by a parser that never emits raw HTML (see
 * `artifact-view.tsx`), so a document still cannot script the app.
 *
 * There is no DELETE. An artifact's link is other people's bookmark, so removal
 * is archiving (`PUT { archived: true }`) and is always reversible.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  getArtifacts,
  getArtifactById,
  createArtifact,
  updateArtifact,
  setArtifactArchived,
} from "../services/sqlite-store.js";

const router = Router();

/**
 * Unknown keys are stripped rather than stored, and an unknown block `type` is
 * rejected outright — a block the viewer can't render must not be silently
 * swallowed into the document, where it would read as data loss later.
 */
const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), body: z.string() }),
  z.object({
    type: z.literal("sql"),
    sql: z.string().trim().min(1),
    label: z.string().optional(),
    connectionId: z.string().optional(),
  }),
]);

export const blocksSchema = z.array(blockSchema).min(1);

/** Exported for tests — the only gate on what shape reaches the database. */
export function parseBlocks(
  value: unknown,
):
  | { ok: true; blocks: z.infer<typeof blocksSchema> }
  | { ok: false; error: string } {
  const result = blocksSchema.safeParse(value);
  if (result.success) return { ok: true, blocks: result.data };
  const first = result.error.issues[0];
  // "blocks[1].sql", not "blocks[1.sql]" — the path is what tells an agent which
  // block to fix, so it has to read like the JSON it sent.
  const where =
    "blocks" +
    (first?.path ?? [])
      .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`))
      .join("");
  return { ok: false, error: `${where}: ${first?.message ?? "invalid"}` };
}

router.get("/", (req: Request, res: Response) => {
  res.json(getArtifacts(req.user!.sub));
});

// Share-link target: visible if shared, or owned by the requester.
router.get("/:id", (req: Request, res: Response) => {
  const artifact = getArtifactById(req.params.id as string, req.user!.sub);
  if (!artifact) {
    res
      .status(404)
      .json({ error: "Artifact not found or not shared with you" });
    return;
  }
  res.json(artifact);
});

router.post("/", (req: Request, res: Response) => {
  const user = req.user!;
  const { title, description, blocks, connectionId, isShared, tags } = req.body;

  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const parsed = parseBlocks(blocks);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  res.status(201).json(
    createArtifact({
      title,
      description,
      blocks: parsed.blocks,
      connectionId,
      createdBy: user.sub,
      createdByEmail: user.email,
      isShared: isShared ?? true,
      tags: tags ?? [],
    }),
  );
});

router.put("/:id", (req: Request, res: Response) => {
  const { blocks, archived, ...rest } = req.body;

  // Archiving is a separate column, not a content edit, so it is applied on its
  // own — and it may be the *only* thing in the body.
  if (archived !== undefined) {
    const flipped = setArtifactArchived(
      req.params.id as string,
      req.user!.sub,
      !!archived,
    );
    if (!flipped) {
      res.status(404).json({ error: "Artifact not found or not owned by you" });
      return;
    }
    if (blocks === undefined && Object.keys(rest).length === 0) {
      res.json(flipped);
      return;
    }
  }

  // Only validate when blocks are actually being replaced — a title-only edit
  // must not have to resend the whole document.
  let parsedBlocks;
  if (blocks !== undefined) {
    const parsed = parseBlocks(blocks);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    parsedBlocks = parsed.blocks;
  }

  const updated = updateArtifact(req.params.id as string, req.user!.sub, {
    ...rest,
    ...(parsedBlocks ? { blocks: parsedBlocks } : {}),
  });
  if (!updated) {
    res.status(404).json({ error: "Artifact not found or not owned by you" });
    return;
  }
  res.json(updated);
});

// No DELETE by design. Archive instead: PUT /:id { "archived": true }.
router.delete("/:id", (_req: Request, res: Response) => {
  res.status(405).json({
    error:
      'Artifacts cannot be deleted. Archive it instead: PUT /api/artifacts/:id with {"archived": true}.',
  });
});

export default router;
