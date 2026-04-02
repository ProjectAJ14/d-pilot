import type { PhiFieldRule } from "../types/index.js";

/**
 * Default PHI masking rules
 * These patterns match column names (case-insensitive) across all tables.
 */
export const DEFAULT_PHI_RULES: Omit<PhiFieldRule, "id">[] = [
  { pattern: "*firstName*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*lastName*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*middleName*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*preferredName*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*dateOfBirth*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*phone*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*email*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*addressLine1*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*addressLine2*", maskingType: "PARTIAL", alwaysMasked: false },
  { pattern: "*zipCode*", maskingType: "PARTIAL", alwaysMasked: false },
];
