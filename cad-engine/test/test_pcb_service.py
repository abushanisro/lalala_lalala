"""The board-file routes (POST /extract/board, /render/board): authentication, limits, error codes and the response
shape. Needs no board files: extraction itself is covered by test_pcb_board_graph.py and by a real board set uploaded
through the platform.
"""
from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

import main

NAME = "layer.gtl"


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(main.app)


def key() -> dict[str, str]:
    return {"X-API-Key": main._CAD_API_KEY}


def post(client, path="/extract/board", headers=None, manifest_text=None, names=(NAME,), described=None):
    manifest = manifest_text if manifest_text is not None else json.dumps({"files": [{"name": n, "role": None} for n in (described if described is not None else names)]})
    return client.post(
        path,
        headers=key() if headers is None else headers,
        data={"manifest": manifest},
        files=[("files", (n, b"x", "application/octet-stream")) for n in names],
    )


@pytest.fixture(autouse=True)
def no_rate_limit(monkeypatch):
    monkeypatch.setattr(main.limiter, "enabled", False)


@pytest.mark.parametrize("headers", [{}, {"X-API-Key": "wrong"}])
@pytest.mark.parametrize("path", ["/extract/board", "/render/board"])
def test_requests_without_the_key_are_refused(client, headers, path):
    assert post(client, path, headers=headers).status_code == 403


def test_an_engine_with_no_key_configured_refuses_board_sets(client, monkeypatch):
    monkeypatch.setattr(main, "_CAD_API_KEY", "")
    assert post(client, headers={"X-API-Key": ""}).status_code == 503


def test_a_bad_manifest_is_422(client):
    response = post(client, manifest_text="not json")
    assert response.status_code == 422 and response.json()["code"] == "invalid_manifest"


def test_a_file_missing_from_the_manifest_is_refused(client):
    response = post(client, described=[])
    assert response.status_code == 422 and response.json()["code"] == "invalid_manifest"


def test_too_many_files_is_413(client, monkeypatch):
    monkeypatch.setattr(main.config, "max_board_files", 1)
    response = post(client, names=("a.gtl", "b.gtl"))
    assert response.status_code == 413 and response.json()["code"] == "too_many_files"


def test_an_oversized_file_is_413(client, monkeypatch):
    monkeypatch.setattr(main.config, "max_file_size_bytes", 0)
    response = post(client)
    assert response.status_code == 413 and response.json()["code"] == "file_too_large"


def test_a_set_without_an_outline_cannot_be_drawn(client):
    response = post(client, "/render/board")
    assert response.status_code == 422 and response.json()["code"] == "render_failed"


def test_health_reports_the_board_extractor_and_its_libraries(client):
    board = client.get("/health").json()["board"]
    assert board["contractVersion"] == "1.3"
    assert board["extractor"] == {"id": "cad-engine-board", "version": "0.3.0"}
    assert board["libraries"]["gerbonara"] not in ("", "unknown") and board["libraries"]["openpyxl"] != "unknown"
    assert board["max_files"] >= 16 and "board_outline" in board["renderedRoles"]


def test_an_unexpected_failure_is_a_500_with_an_error_id_and_no_leak(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("secret internal detail with customer content")

    monkeypatch.setattr(main, "extract_board", boom)
    quiet = TestClient(main.app, raise_server_exceptions=False)
    response = post(quiet)
    assert response.status_code == 500
    assert "secret" not in json.dumps(response.json()) and "error " in response.json()["detail"]


@pytest.mark.parametrize(
    ("raised", "code"),
    [(main.ExtractionError("secret: /srv/acme/board.gtl line 7"), "extraction_failed"), (ValueError("secret: GBK bytes 0xff"), "unreadable_file")],
)
def test_a_refused_set_answers_with_an_error_id_and_logs_the_reason(client, monkeypatch, caplog, raised, code):
    def refuse(*args, **kwargs):
        raise raised

    monkeypatch.setattr(main, "extract_board", refuse)
    with caplog.at_level(logging.WARNING, logger="pcb.service"):
        response = post(client)
    body = response.json()
    assert response.status_code == 422 and body["code"] == code
    assert "secret" not in json.dumps(body) and len(body["errorId"]) == 32 and body["errorId"] in body["message"]
    logged = [r for r in caplog.records if body["errorId"] in r.getMessage()]
    assert logged and logged[0].exc_info[1] is raised


def test_a_drawing_failure_does_not_echo_the_reason(client):
    body = post(client, "/render/board").json()
    assert body["code"] == "render_failed" and "outline" not in body["message"] and body["errorId"] in body["message"]


def test_an_unreadable_pick_place_file_is_reported_by_id_only(monkeypatch, caplog):
    from pcb.extraction import render

    monkeypatch.setattr(render, "read_tabular", lambda f: ("placement", object()))

    def refuse(table, layers):
        raise render.PlacementError("Pick Place layer 'secret-customer-layer' is not in the placement layer table")

    monkeypatch.setattr(render, "read_components", refuse)
    with caplog.at_level(logging.WARNING, logger="pcb.extraction.render"):
        components, reason = render._scene_components([render.InputFile("pp.csv", b"x")], {})
    assert components == [] and "secret" not in reason
    assert any(r.exc_info and "secret" in str(r.exc_info[1]) for r in caplog.records)
