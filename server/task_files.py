"""Validated task attachments stored with the task record."""
import base64
import binascii
import uuid

MAX_FILES = 6
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 40 * 1024 * 1024
MAX_REQUEST_BYTES = 42 * 1024 * 1024


def decode_files(files):
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise ValueError("每次最多上传 6 个文件。")
    decoded, total = [], 0
    for file in files:
        if not isinstance(file, dict):
            raise ValueError("文件数据格式不正确。")
        encoded = file.get("data", "")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_FILE_BYTES + 2) // 3) * 4:
            raise ValueError("单个文件不能超过 20 MB。")
        try:
            body = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("文件数据损坏，请重新选择。") from None
        if not body or len(body) > MAX_FILE_BYTES:
            raise ValueError("文件不能为空，且单个不能超过 20 MB。")
        total += len(body)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("文件合计不能超过 40 MB。")
        name = str(file.get("name") or "附件").replace("\\", "/").rsplit("/", 1)[-1]
        name = "".join(char for char in name if char not in "\r\n\x00")[:160].strip() or "附件"
        content_type = str(file.get("contentType") or file.get("content_type") or "application/octet-stream")[:120]
        if any(char in content_type for char in "\r\n"):
            content_type = "application/octet-stream"
        decoded.append((str(uuid.uuid4()), name, content_type, body))
    return decoded


def attach_metadata(db, records):
    if not records:
        return
    by_id = {record["id"]: record for record in records}
    for record in records:
        record["attachments"] = []
    placeholders = ",".join("?" for _ in by_id)
    for row in db.execute(
        f"SELECT id, task_id, name, content_type, length(body) AS size FROM task_attachments WHERE task_id IN ({placeholders}) ORDER BY rowid",
        tuple(by_id),
    ):
        by_id[row["task_id"]]["attachments"].append({
            "id": row["id"], "name": row["name"],
            "content_type": row["content_type"], "size": row["size"],
        })
