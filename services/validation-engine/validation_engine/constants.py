"""Shared labels and mappings used by the admin validation feature."""

SUPPORTED_BUSINESS_OBJECTS = (
    "MATERIAL_MASTER",
    "SALES_ORDER",
    "GL_ACCOUNT",
    "BUSINESS_PARTNER",
    "PURCHASE_ORDER",
)

NONE_MATCHED = "NONE_MATCHED"
ALLOWED_DETECTION_LABELS = (*SUPPORTED_BUSINESS_OBJECTS, NONE_MATCHED)
ACCEPTABLE_CONFIDENCE = frozenset({"high", "medium"})

DETECTOR_TO_RULES_BO = {
    "MATERIAL_MASTER": "MM",
    "PURCHASE_ORDER": "PO",
    "GL_ACCOUNT": "GL Account",
    "BUSINESS_PARTNER": "BP",
    "SALES_ORDER": "SO",
}

RULES_BO_TO_DETECTOR = {v: k for k, v in DETECTOR_TO_RULES_BO.items()}

STATUS_PASS = "PASS"
STATUS_FAIL = "FAIL"
STATUS_WARNING = "WARNING"

VALIDATION_STATUS_COL = "validation_status"
VALIDATION_ERRORS_COL = "validation_errors"

INFERRED_DATS_FIELDS = frozenset(
    {
        "BEDAT",
        "AEDAT",
        "BUDAT",
        "BLDAT",
        "EINDT",
        "DATUM",
        "ERDAT",
        "LAEDA",
        "CPUDT",
        "BEGDA",
        "ENDDA",
        "GSTRP",
        "GLTRP",
        "FKDAT",
        "BILLDATE",
        "VALUT",
        "AUGDT",
    }
)

FIELD_EQUIVALENCE_GROUPS = (
    ("MATERIALNUMBER", "MATNR"),
    ("MATERIALTYPE", "MTART"),
    ("MATERIALGROUP", "MATKL"),
    ("MATERIALDESC", "MAKTX", "MATERIALDESCRIPTION"),
    ("UOMCODE", "MEINS", "BASEUNITOFMEASURE"),
    ("PLANTCODE", "WERKS", "PLANT"),
    ("LANGUAGECODE", "SPRAS", "LANGUAGEKEY"),
    ("GROSSWEIGHT", "BRGEW"),
    ("NETWEIGHT", "NTGEW"),
    ("WEIGHTUNIT", "GEWEI"),
    ("PONUMBER", "EBELN", "PURCHASEORDER"),
    ("POITEM", "EBELP", "ITEMNUMBER"),
    ("VENDORNUMBER", "LIFNR", "VENDOR"),
    ("PARTNERNUMBER", "PARTNER", "BPNUMBER", "KUNNR", "LIFNR"),
    ("SALESORDERNUMBER", "VBELN", "SALESORDER"),
    ("SALESORDERITEM", "POSNR", "ITEM"),
    ("GLACCOUNT", "SAKNR", "GLACCOUNTNUMBER", "HKONT"),
)

DEFAULT_CHUNKSIZE = 50_000
# CSV files at or under this size are read in a single frame. Above it we use
# pandas chunksize so a raised upload cap cannot load a multi-hundred-MB CSV
# into one DataFrame. Current Node UPLOAD_MAX_BYTES is 5 MiB, so typical
# admin files take the single-frame path.
CSV_CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024
DEFAULT_SAMPLE_ROWS = 5
DEFAULT_BEDROCK_MAX_TOKENS = 400
AFFECTED_SAMPLE_LIMIT = 25
SAMPLE_VALUE_LIMIT = 8
INTERNAL_API_HEADER = "X-Internal-Service-Key"
