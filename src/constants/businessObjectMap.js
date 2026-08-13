/**
 * Maps SAP detector labels to validation_rules.business_object values.
 */
export const DETECTOR_TO_RULES_BO = Object.freeze({
  MATERIAL_MASTER: "MM",
  PURCHASE_ORDER: "PO",
  GL_ACCOUNT: "GL Account",
  BUSINESS_PARTNER: "BP",
  SALES_ORDER: "SO",
});

export function mapDetectorToRulesBusinessObject(detectorLabel) {
  const key = String(detectorLabel || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  return DETECTOR_TO_RULES_BO[key] || null;
}
