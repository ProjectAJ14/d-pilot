import { Router, Request, Response } from "express";
import { getPhiRules, upsertPhiRule, deletePhiRule, getPhiMaskedEnvs, setSetting } from "../services/sqlite-store.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Environment } from "../types/index.js";

const router = Router();

// Masked environments
router.get("/masked-envs", (_req: Request, res: Response) => {
  res.json({ environments: getPhiMaskedEnvs() });
});

router.put("/masked-envs", requireAdmin, (req: Request, res: Response) => {
  const { environments } = req.body;
  const valid: Environment[] = ["DEV", "QA", "STG", "PROD"];
  if (!Array.isArray(environments) || !environments.every((e: string) => valid.includes(e as Environment))) {
    res.status(400).json({ error: "Invalid environments list. Allowed: DEV, QA, STG, PROD" });
    return;
  }
  setSetting("phi_masked_envs", JSON.stringify(environments));
  res.json({ environments });
});

// Anyone can view PHI rules
router.get("/", (_req: Request, res: Response) => {
  res.json(getPhiRules());
});

// Only admins can modify PHI rules
router.post("/", requireAdmin, (req: Request, res: Response) => {
  const { pattern, maskingType, alwaysMasked, database, table } = req.body;

  if (!pattern || !maskingType) {
    res.status(400).json({ error: "pattern and maskingType are required" });
    return;
  }

  const rule = upsertPhiRule({ pattern, maskingType, alwaysMasked: alwaysMasked ?? false, database, table });
  res.status(201).json(rule);
});

router.put("/:id", requireAdmin, (req: Request, res: Response) => {
  const { pattern, maskingType, alwaysMasked, database, table } = req.body;
  const rule = upsertPhiRule({ id: req.params.id as string, pattern, maskingType, alwaysMasked, database, table });
  res.json(rule);
});

router.delete("/:id", requireAdmin, (req: Request, res: Response) => {
  const deleted = deletePhiRule(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json({ deleted: true });
});

export default router;
