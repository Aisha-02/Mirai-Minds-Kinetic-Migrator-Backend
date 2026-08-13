from validation_engine.classify import build_detection_prompt, detection_from_model_payload
from validation_engine.constants import ALLOWED_DETECTION_LABELS
from validation_engine.jsonutil import extract_json_object


def test_detection_prompt_matches_comparison_contract():
    prompt = build_detection_prompt(
        ["MATNR", "MTART"],
        [{"MATNR": "100", "MTART": "FERT"}],
    )
    assert "Allowed values for businessObject (exactly one):" in prompt
    for label in ALLOWED_DETECTION_LABELS:
        assert f"- {label}" in prompt
    assert '{"businessObject":"MATERIAL_MASTER","confidence":"high","reasoning":"short explanation"}' in prompt
    assert "STRICT JSON only" in prompt
    assert "NONE_MATCHED" in prompt


def test_extract_json_handles_fences():
    text = '```json\n{"businessObject":"SALES_ORDER","confidence":"medium","reasoning":"ok"}\n```'
    parsed = extract_json_object(text)
    assert parsed["businessObject"] == "SALES_ORDER"


def test_high_confidence_match_is_classified():
    result = detection_from_model_payload(
        {
            "businessObject": "MATERIAL_MASTER",
            "confidence": "high",
            "reasoning": "MATNR present",
        }
    )
    assert result.classified
    assert result.business_object == "MATERIAL_MASTER"


def test_none_matched_and_low_confidence_are_not_forced():
    none = detection_from_model_payload(
        {"businessObject": "NONE_MATCHED", "confidence": "high", "reasoning": "unknown"}
    )
    assert not none.classified
    assert none.needs_manual_selection
    low = detection_from_model_payload(
        {"businessObject": "GL_ACCOUNT", "confidence": "low", "reasoning": "weak"}
    )
    assert not low.classified
    assert low.needs_manual_selection


def test_unsupported_label_maps_to_none_matched():
    result = detection_from_model_payload(
        {"businessObject": "WIDGET", "confidence": "high", "reasoning": "nope"}
    )
    assert result.business_object == "NONE_MATCHED"
    assert result.error["code"] == "UNSUPPORTED_LABEL"


def test_malformed_response():
    result = detection_from_model_payload(extract_json_object("not json"), raw_text="not json")
    assert result.error["code"] == "MALFORMED_RESPONSE"
