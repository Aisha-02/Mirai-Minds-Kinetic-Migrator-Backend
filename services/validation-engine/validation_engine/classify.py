"""Business-object classification — same prompt/JSON contract as businessObjectDetector.js."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from validation_engine.constants import (
    ACCEPTABLE_CONFIDENCE,
    ALLOWED_DETECTION_LABELS,
    DEFAULT_BEDROCK_MAX_TOKENS,
    DEFAULT_SAMPLE_ROWS,
    NONE_MATCHED,
    SUPPORTED_BUSINESS_OBJECTS,
)
from validation_engine.jsonutil import extract_json_object


@dataclass
class DetectionResult:
    ok: bool
    needs_manual_selection: bool
    business_object: str | None = None
    confidence: str | None = None
    reasoning: str = ""
    model_id: str | None = None
    message: str | None = None
    error: dict[str, Any] | None = None
    candidates: list[str] = field(default_factory=lambda: list(SUPPORTED_BUSINESS_OBJECTS))

    @property
    def classified(self) -> bool:
        return bool(self.ok) and not self.needs_manual_selection

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "needsManualSelection": self.needs_manual_selection,
            "businessObject": self.business_object,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "modelId": self.model_id,
            "message": self.message,
            "error": self.error,
            "candidates": self.candidates,
        }


class BusinessObjectClassifier(Protocol):
    def classify(
        self,
        columns: list[str],
        sample_rows: list[dict[str, Any]] | None = None,
        table: Any | None = None,
    ) -> DetectionResult:
        ...


def build_detection_prompt(
    columns: list[str],
    sample_rows: list[dict[str, Any]],
    sample_limit: int = DEFAULT_SAMPLE_ROWS,
) -> str:
    labels = "\n".join(f"- {label}" for label in ALLOWED_DETECTION_LABELS)
    limited = sample_rows[:sample_limit]
    return (
        "You are classifying an SAP migration preload dataset into exactly one business object type.\n"
        "\n"
        "Allowed values for businessObject (exactly one):\n"
        f"{labels}\n"
        "\n"
        "Rules:\n"
        "- Choose NONE_MATCHED if the dataset does not clearly match one type.\n"
        "- confidence must be one of: high, medium, low\n"
        "- Respond with STRICT JSON only — no markdown, no prose outside JSON.\n"
        "- JSON shape:\n"
        '{"businessObject":"MATERIAL_MASTER","confidence":"high","reasoning":"short explanation"}\n'
        "\n"
        "Column headers:\n"
        f"{json.dumps(columns)}\n"
        "\n"
        f"Sample rows (up to {sample_limit}):\n"
        f"{json.dumps(limited)}"
    )


def normalize_confidence(value: object) -> str:
    confidence = str(value or "").strip().lower()
    return confidence if confidence in {"high", "medium", "low"} else "low"


def normalize_business_object_label(value: object) -> str:
    return str(value or "").strip().upper().replace(" ", "_")


def detection_from_model_payload(
    parsed: dict[str, Any] | None,
    raw_text: str | None = None,
    model_id: str | None = None,
) -> DetectionResult:
    if not parsed:
        return DetectionResult(
            ok=False,
            needs_manual_selection=True,
            error={
                "code": "MALFORMED_RESPONSE",
                "message": (
                    "Could not parse a JSON business-object classification "
                    "from the model response"
                ),
                "details": str(raw_text or "")[:300],
            },
        )

    business_object = normalize_business_object_label(parsed.get("businessObject"))
    confidence = normalize_confidence(parsed.get("confidence"))
    reasoning = str(parsed.get("reasoning") or "").strip()

    if business_object not in ALLOWED_DETECTION_LABELS:
        return DetectionResult(
            ok=False,
            needs_manual_selection=True,
            business_object=NONE_MATCHED,
            confidence="low",
            reasoning=reasoning or "Model returned an unsupported label",
            error={
                "code": "UNSUPPORTED_LABEL",
                "message": (
                    f"Model returned unsupported business object "
                    f"'{parsed.get('businessObject')}'"
                ),
            },
        )

    needs_manual = business_object == NONE_MATCHED or confidence not in ACCEPTABLE_CONFIDENCE
    if needs_manual:
        return DetectionResult(
            ok=False,
            needs_manual_selection=True,
            business_object=business_object,
            confidence=confidence,
            reasoning=reasoning,
            message="Couldn't auto-detect — please select the business object manually",
            candidates=list(SUPPORTED_BUSINESS_OBJECTS),
        )

    return DetectionResult(
        ok=True,
        needs_manual_selection=False,
        business_object=business_object,
        confidence=confidence,
        reasoning=reasoning,
        model_id=model_id,
    )


class ForcedClassifier:
    def __init__(self, business_object: str, reasoning: str = "Manually selected by user") -> None:
        self.business_object = normalize_business_object_label(business_object)
        self.reasoning = reasoning

    def classify(
        self,
        columns: list[str],
        sample_rows: list[dict[str, Any]] | None = None,
        table: Any | None = None,
    ) -> DetectionResult:
        if not columns:
            return DetectionResult(
                ok=False,
                needs_manual_selection=True,
                error={
                    "code": "INVALID_INPUT",
                    "message": "No column headers available for business object detection",
                },
            )
        if self.business_object not in ALLOWED_DETECTION_LABELS or self.business_object == NONE_MATCHED:
            return DetectionResult(
                ok=False,
                needs_manual_selection=True,
                business_object=NONE_MATCHED,
                confidence="low",
                reasoning="Forced label is not a supported business object",
            )
        return DetectionResult(
            ok=True,
            needs_manual_selection=False,
            business_object=self.business_object,
            confidence="high",
            reasoning=self.reasoning,
        )


class BedrockClassifier:
    """Bedrock Converse classifier. Uses AWS_BEARER_TOKEN_BEDROCK when set (same as Node)."""

    def __init__(
        self,
        client: Any | None = None,
        model_id: str | None = None,
        region: str | None = None,
        max_tokens: int = DEFAULT_BEDROCK_MAX_TOKENS,
    ) -> None:
        self._client = client
        self.model_id = model_id or os.environ.get("BEDROCK_MODEL_ID")
        self.region = (
            region
            or os.environ.get("BEDROCK_REGION")
            or os.environ.get("AWS_REGION")
            or os.environ.get("AWS_DEFAULT_REGION")
        )
        self.max_tokens = max_tokens

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        import boto3

        # Same auth as Node bedrockClient: AWS_BEARER_TOKEN_BEDROCK (API key)
        # is picked up automatically by boto3; IAM keys are the fallback.
        kwargs: dict[str, Any] = {}
        if self.region:
            kwargs["region_name"] = self.region
        self._client = boto3.client("bedrock-runtime", **kwargs)
        return self._client

    def classify(
        self,
        columns: list[str],
        sample_rows: list[dict[str, Any]] | None = None,
        table: Any | None = None,
    ) -> DetectionResult:
        if not columns:
            return DetectionResult(
                ok=False,
                needs_manual_selection=True,
                error={
                    "code": "INVALID_INPUT",
                    "message": "No column headers available for business object detection",
                },
            )
        if not self.model_id:
            return DetectionResult(
                ok=False,
                needs_manual_selection=True,
                error={"code": "CONFIG", "message": "BEDROCK_MODEL_ID is not configured"},
            )

        prompt = build_detection_prompt(columns, sample_rows or [])
        skip_temperature = (
            str(os.environ.get("BEDROCK_SKIP_TEMPERATURE", "")).lower() == "true"
            or "claude-sonnet-5" in str(self.model_id or "").lower()
        )
        inference: dict[str, Any] = {"maxTokens": self.max_tokens}
        if not skip_temperature:
            inference["temperature"] = 0

        try:
            client = self._client_or_create()
            response = client.converse(
                modelId=self.model_id,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig=inference,
            )
        except Exception as err:  # noqa: BLE001
            return DetectionResult(
                ok=False,
                needs_manual_selection=True,
                error={"code": "BEDROCK_ERROR", "message": str(err) or "Business object detection failed"},
                message="Couldn't auto-detect — please select the business object manually",
                candidates=list(SUPPORTED_BUSINESS_OBJECTS),
            )

        text = _converse_text(response)
        parsed = extract_json_object(text)
        return detection_from_model_payload(parsed, raw_text=text, model_id=self.model_id)


def _converse_text(response: dict[str, Any]) -> str:
    output = response.get("output") or {}
    message = output.get("message") or {}
    parts = message.get("content") or []
    return "\n".join(str(part.get("text")) for part in parts if isinstance(part, dict) and part.get("text"))
