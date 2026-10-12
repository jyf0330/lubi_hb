"""Exercise HTTP resources and request logging with real buffered stdout."""
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urljoin
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import app
app.DB_PATH = Path(sys.argv[2])
app.initialize_database()
server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
print(server.server_port, flush=True)
server.serve_forever()
"""


class HttpRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        env = {key: value for key, value in os.environ.items() if key != "PYTHONUNBUFFERED"}
        self.process = subprocess.Popen(
            [sys.executable, "-c", BOOTSTRAP, str(ROOT / "server"), str(Path(temporary.name) / "tasks.db")],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            env=env,
        )
        self.addCleanup(self.stop_server)
        self.base = f"http://127.0.0.1:{int(self.read_log_line())}"

    def stop_server(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()

    def read_log_line(self):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=3), "Server output was not flushed while running")
        return self.process.stdout.readline().decode()

    def test_request_log_is_available_before_process_exit(self):
        with urlopen(self.base + "/health", timeout=3) as response:
            self.assertEqual(response.status, 200)
            response.read()
        self.assertIn('"GET /health HTTP/1.1" 200', self.read_log_line())
        self.assertIsNone(self.process.poll())

    def test_page_icon_loads_for_employee_url_variants(self):
        expected = (ROOT / "server/static/favicon.svg").read_bytes()
        for path in ("/", "/index.html", "/employee", "/employee/", "/employee.html"):
            with self.subTest(path=path):
                page_url = self.base + path
                with urlopen(page_url, timeout=3) as response:
                    self.assertIn('rel="icon" type="image/svg+xml" href="favicon.svg"', response.read().decode())
                with urlopen(urljoin(page_url, "favicon.svg"), timeout=3) as response:
                    self.assertEqual(response.headers.get_content_type(), "image/svg+xml")
                    self.assertEqual(response.read(), expected)


if __name__ == "__main__":
    unittest.main()
