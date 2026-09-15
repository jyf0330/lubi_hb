import base64
import sqlite3
import unittest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import task_files


class TaskFileTests(unittest.TestCase):
    def test_decode_files_preserves_name_and_content_type(self):
        payload = base64.b64encode(b"hello").decode()
        files = task_files.decode_files([{"name": "deliverable.txt", "data": payload, "contentType": "text/plain"}])
        self.assertEqual(files[0][1:], ("deliverable.txt", "text/plain", b"hello"))

    def test_decode_files_rejects_invalid_payload(self):
        with self.assertRaisesRegex(ValueError, "文件数据损坏"):
            task_files.decode_files([{"name": "bad.bin", "data": "not-base64"}])

    def test_attach_metadata_is_scoped_to_task_ids(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.executescript("""
          CREATE TABLE task_attachments (
            id TEXT PRIMARY KEY, task_id TEXT, name TEXT,
            content_type TEXT, body BLOB
          );
          INSERT INTO task_attachments VALUES ('a1', 'task-1', 'one.txt', 'text/plain', X'6F6E65');
          INSERT INTO task_attachments VALUES ('a2', 'task-2', 'two.txt', 'text/plain', X'74776F');
        """)
        records = [{"id": "task-1"}]
        task_files.attach_metadata(db, records)
        self.assertEqual(records[0]["attachments"][0]["name"], "one.txt")


if __name__ == "__main__":
    unittest.main()
