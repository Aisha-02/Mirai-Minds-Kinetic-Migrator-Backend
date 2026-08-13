-- Allow Sales Order (SO) in validation_rules business_object check

ALTER TABLE validation_rules
  DROP CONSTRAINT IF EXISTS validation_rules_business_object_check;

ALTER TABLE validation_rules
  ADD CONSTRAINT validation_rules_business_object_check
  CHECK (business_object IN ('MM', 'PO', 'GL Account', 'BP', 'SO'));
