"""Python side of the feature-graph contract: the schemas under pcb/contract/schemas are the single source of truth.

The backend stores the board feature graph cad-engine returns as it is (costing/pcb/board-graph/pcb-geometry.ts): these schemas are its contract.
No example documents are bundled: graphs come from real uploads.
"""
import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

CONTRACT = Path(__file__).resolve().parent.parent / "contract"
SCHEMAS = {
    "board": json.loads((CONTRACT / "schemas" / "board_feature_graph.v1.schema.json").read_text()),
    "harness": json.loads((CONTRACT / "schemas" / "harness_feature_graph.v1.schema.json").read_text()),
}


@pytest.mark.parametrize("schema", SCHEMAS.values(), ids=SCHEMAS.keys())
def test_schemas_are_valid_draft7(schema):
    Draft7Validator.check_schema(schema)
