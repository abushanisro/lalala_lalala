"""The board-file requests (POST /extract/board, /render/board): the manifest, the file limits and the refusal shape.

A board set is several files (Gerber layers, drill file, drill report, Pick Place, BOM workbook) described by a JSON
manifest: each file's role from the platform's file-role table, the lookup tables the extraction needs (placement layer
names, footprint classes) and the facts a person supplied. The engine holds no lookup data of its own. Customer files are
never logged (counts only).
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import UploadFile
from fastapi.responses import JSONResponse

from pcb.extraction.board import InputFile, Lookups, PackageEntry, Supplied

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Refusal:
    """The request itself is refused (manifest, file count, file size) before any file is read as a board layer. A value,
    not an exception: its fixed message is what the caller sees."""

    code: str
    message: str
    status: int = 422

    def response(self) -> JSONResponse:
        return JSONResponse(status_code=self.status, content={"code": self.code, "message": self.message})


@dataclass(frozen=True)
class Manifest:
    roles: dict[str, str | None]  # file name -> board-file role (None: a table or a document)
    lookups: Lookups
    supplied: dict[str, Supplied]
    tier: str


def parse_manifest(raw: str) -> Manifest | Refusal:
    try:
        manifest = json.loads(raw)
        roles = {str(item["name"]): item.get("role") for item in manifest["files"]}
        lookups_in = manifest.get("lookups", {})
        lookups = Lookups(
            placement_layers={str(k).lower(): str(v) for k, v in lookups_in.get("placementLayers", {}).items()},
            packages={
                name: PackageEntry(entry.get("packageClass"), entry["mountType"], entry.get("pinCount"))
                for name, entry in lookups_in.get("packages", {}).items()
            },
        )
        supplied = {key: Supplied(item["value"], item["note"]) for key, item in manifest.get("supplied", {}).items()}
        return Manifest(roles, lookups, supplied, manifest.get("inputTier", "B"))
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        return Refusal("invalid_manifest", f"manifest not understood: {type(error).__name__}")


async def read_board_files(files: list[UploadFile], roles: dict[str, str | None], max_files: int, max_file_bytes: int) -> list[InputFile] | Refusal:
    if len(files) > max_files:
        return Refusal("too_many_files", f"at most {max_files} files per request", 413)
    inputs: list[InputFile] = []
    for upload in files:
        data = await upload.read(max_file_bytes + 1)
        if len(data) > max_file_bytes:
            return Refusal("file_too_large", f"{upload.filename} exceeds {max_file_bytes // (1024 * 1024)} MB", 413)
        if upload.filename not in roles:
            return Refusal("invalid_manifest", f"{upload.filename} is not described in the manifest")
        inputs.append(InputFile(upload.filename, data, roles[upload.filename]))
    return inputs


def refused(code: str, message: str, request_id: str) -> JSONResponse:
    """A 422 for the exception being handled. Its text (library internals, file content) goes only to the log, with the
    traceback, under a fresh error id; the caller gets the code, a fixed message and that id."""
    error_id = uuid.uuid4().hex
    log.warning("%s (error %s, request %s)", code, error_id, request_id, exc_info=True)
    return JSONResponse(status_code=422, content={"code": code, "message": f"{message} (error {error_id})", "errorId": error_id})


def board_capabilities() -> dict[str, Any]:
    from pcb.extraction.board import CONTRACT_VERSION, PARSER_ID, PARSER_VERSION
    from pcb.extraction.render import DRAWN_ROLES

    return {
        "contractVersion": CONTRACT_VERSION,
        "extractor": {"id": PARSER_ID, "version": PARSER_VERSION},
        "renderedRoles": list(DRAWN_ROLES),
    }
