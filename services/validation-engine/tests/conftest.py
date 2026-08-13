from __future__ import annotations

from typing import Any

from validation_engine.classify import DetectionResult
from validation_engine.columns import normalize_field_key


def mm_rules() -> dict[str, Any]:
    return {
        "businessObject": "MM",
        "fields": [
            {
                "fieldName": "MATERIAL_NUMBER",
                "key": "X",
                "dataType": "CHAR",
                "length": 18,
                "rules": [
                    {
                        "ruleName": "MATNR_ALPHA_Conversion_Padding",
                        "source": "AI",
                        "type": "transformation",
                        "description": "Inconsistent padding causes lookup failures.",
                        "constraint": "Left-pad numeric material numbers with zeros.",
                        "severity": "error",
                        "category": "format",
                    }
                ],
            },
            {
                "fieldName": "MATERIAL_TYPE",
                "key": "",
                "dataType": "CHAR",
                "length": 4,
                "rules": [
                    {
                        "ruleName": "MTART_Valid_Domain_Value",
                        "source": "AI",
                        "type": "validation",
                        "description": "Must match a valid SAP MTART value.",
                        "constraint": "Check MATERIAL_TYPE against T134.",
                        "severity": "error",
                        "category": "domain",
                    }
                ],
            },
            {
                "fieldName": "GROSS_WEIGHT",
                "key": "",
                "dataType": "QUAN",
                "rules": [
                    {
                        "ruleName": "Non-Negative Weight Enforcement",
                        "source": "AI",
                        "type": "validation",
                        "description": "Negative gross weight is invalid.",
                        "constraint": "GROSS_WEIGHT must be >= 0; reject or flag negative values.",
                        "severity": "error",
                        "category": "range",
                    }
                ],
            },
            {
                "fieldName": "NET_WEIGHT",
                "key": "",
                "dataType": "QUAN",
                "rules": [
                    {
                        "ruleName": "Net Weight Not Exceeding Gross Weight",
                        "source": "AI",
                        "type": "validation",
                        "description": "Net weight cannot exceed gross weight.",
                        "constraint": "NET_WEIGHT must be <= corresponding GROSS_WEIGHT for the same material record.",
                        "severity": "error",
                        "category": "consistency",
                    }
                ],
            },
            {
                "fieldName": "BEDAT",
                "key": "",
                "dataType": "DATS",
                "rules": [],
            },
        ],
    }


def so_rules() -> dict[str, Any]:
    return {
        "businessObject": "SO",
        "fields": [
            {
                "fieldName": "VBELN",
                "key": "X",
                "dataType": "CHAR",
                "length": 10,
                "rules": [],
            },
            {
                "fieldName": "POSNR",
                "key": "",
                "dataType": "NUMC",
                "length": 6,
                "rules": [],
            },
        ],
    }


class HeaderClassifier:
    """Deterministic stand-in for Bedrock, keyed off column headers."""

    def classify(
        self,
        columns: list[str],
        sample_rows: list[dict[str, Any]] | None = None,
        table: Any | None = None,
    ) -> DetectionResult:
        labels = {normalize_field_key(col) for col in columns}
        if labels & {"MATNR", "MATERIALNUMBER", "MATERIALTYPE"}:
            return DetectionResult(
                ok=True,
                needs_manual_selection=False,
                business_object="MATERIAL_MASTER",
                confidence="high",
                reasoning="Material master columns present",
            )
        if labels & {"SALESORDER", "VBELN", "SALESORDERNUMBER"}:
            return DetectionResult(
                ok=True,
                needs_manual_selection=False,
                business_object="SALES_ORDER",
                confidence="high",
                reasoning="Sales order columns present",
            )
        if labels & {"EBELN", "PURCHASEORDER", "PONUMBER"}:
            return DetectionResult(
                ok=True,
                needs_manual_selection=False,
                business_object="PURCHASE_ORDER",
                confidence="high",
                reasoning="Purchase order columns present",
            )
        return DetectionResult(
            ok=False,
            needs_manual_selection=True,
            business_object="NONE_MATCHED",
            confidence="low",
            reasoning="No known business-object columns",
            message="Couldn't auto-detect — please select the business object manually",
        )
