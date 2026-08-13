from validation_engine.payload import normalize_rules_map


def test_normalize_detector_keys_and_list():
    mapped = normalize_rules_map(
        {
            "MATERIAL_MASTER": {"businessObject": "MM", "fields": [{"fieldName": "MATNR"}]},
            "SO": {"fields": [{"fieldName": "VBELN"}]},
        }
    )
    assert "MM" in mapped
    assert "SO" in mapped

    listed = normalize_rules_map(
        [{"businessObject": "GL Account", "fields": [{"fieldName": "SAKNR"}]}]
    )
    assert "GL Account" in listed
