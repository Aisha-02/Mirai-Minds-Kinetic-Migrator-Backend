export const BUSINESS_OBJECTS = ["MM", "PO", "GL Account", "BP", "SO"];

export function isBusinessObject(value) {
  return BUSINESS_OBJECTS.includes(value);
}
