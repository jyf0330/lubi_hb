"""Validated compressed-package attachments for progress reports."""
import base64
import binascii
import uuid

MAX_ARCHIVES = 2
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
# Base64 plus JSON overhead, with a small safety margin for filenames and fields.
MAX_REQUEST_BYTES = 29 * 1024 * 1024


def _signature(body):
    if body.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        return "application/zip", ".zip"
    if body.startswith(b"Rar!\x1a\x07\x00") or body.startswith(b"Rar!\x1a\x07\x01\x00"):
        return "application/x-rar-compressed", ".rar"
    if body.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "application/x-7z-compressed", ".7z"
    return None, None


def decode_archives(archives):
    if not isinstance(archives, list) or len(archives) > MAX_ARCHIVES:
        raise ValueError("每次汇报最多上传 2 个压缩包。")
    decoded, total = [], 0
    for archive in archives:
        if not isinstance(archive, dict):
            raise ValueError("压缩包数据格式不正确。")
        encoded = archive.get("data", "")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_ARCHIVE_BYTES + 2) // 3) * 4:
            raise ValueError("单个压缩包不能超过 20 MB。")
        try:
            body = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("压缩包数据损坏，请重新选择。") from None
        if not body or len(body) > MAX_ARCHIVE_BYTES:
            raise ValueError("压缩包不能为空，且单个不能超过 20 MB。")
        mime, extension = _signature(body)
        if not mime:
            raise ValueError("仅支持 ZIP、RAR 和 7Z 压缩包。")
        total += len(body)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("每次汇报的压缩包合计不能超过 20 MB。")
        name = str(archive.get("name") or "压缩包").replace("\\", "/").rsplit("/", 1)[-1]
        name = "".join(char for char in name if char not in "\r\n\x00")[:120].strip() or "压缩包"
        if not name.lower().endswith(extension):
            name += extension
        decoded.append((str(uuid.uuid4()), name, mime, body))
    return decoded


def attach_metadata(db, reports):
    if not reports:
        return
    by_id = {report["id"]: report for report in reports}
    for report in reports:
        report["attachments"] = []
    placeholders = ",".join("?" for _ in by_id)
    for row in db.execute(
        f"SELECT id, progress_id, name, content_type, length(body) AS size FROM progress_attachments WHERE progress_id IN ({placeholders}) ORDER BY rowid",
        tuple(by_id),
    ):
        by_id[row["progress_id"]]["attachments"].append({
            "id": row["id"], "name": row["name"],
            "content_type": row["content_type"], "size": row["size"],
        })
