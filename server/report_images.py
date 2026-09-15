"""Bounded raster attachments stored atomically with their progress report."""
import base64
import binascii
import uuid

MAX_IMAGES = 6
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MAX_REQUEST_BYTES = 17 * 1024 * 1024


def decode_images(images):
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise ValueError("每次汇报最多上传 6 张图片。")
    decoded, total = [], 0
    for image in images:
        if not isinstance(image, dict):
            raise ValueError("图片数据格式不正确。")
        encoded = image.get("data", "")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
            raise ValueError("单张图片不能超过 4 MB。")
        try:
            body = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("图片数据损坏，请重新选择。") from None
        if not body or len(body) > MAX_IMAGE_BYTES:
            raise ValueError("图片不能为空，且单张不能超过 4 MB。")
        # Serve only raster signatures with a server-selected MIME type and nosniff.
        if body.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif body.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif body.startswith(b"RIFF") and body[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            raise ValueError("仅支持 PNG、JPG 和 WebP 图片。")
        total += len(body)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("每次汇报的图片合计不能超过 12 MB。")
        name = str(image.get("name") or "图片").replace("\\", "/").rsplit("/", 1)[-1][:120]
        decoded.append((str(uuid.uuid4()), name, mime, body))
    return decoded


def attach_metadata(db, reports):
    if not reports:
        return
    by_id = {report["id"]: report for report in reports}
    for report in reports:
        report["images"] = []
    placeholders = ",".join("?" for _ in by_id)
    for row in db.execute(
        f"SELECT id, progress_id, name, content_type, length(body) AS size FROM progress_images WHERE progress_id IN ({placeholders}) ORDER BY rowid",
        tuple(by_id),
    ):
        by_id[row["progress_id"]]["images"].append({
            "id": row["id"], "name": row["name"],
            "content_type": row["content_type"], "size": row["size"],
        })
