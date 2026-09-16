import base64
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import app
import report_images
import report_files

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=')


class ReportImagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / 'tasks.db'
        app.initialize_database()
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        _, self.worker = self.post('login', {'name': '赵浩丞'})
        _, self.owner = self.post('login', {'name': '余文浩'})
        _, self.other = self.post('login', {'name': '余文滔'})
        self.task = app.call_tool('YWH', 'owner_insert_task', {
            'title': '检查图片汇报', 'assignee': 'ZHC', 'acceptance_criteria': '图片可查看',
        })['structuredContent']['task_id']
        app.call_tool('ZHC', 'work_start_task', {'task_id': self.task})

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def post(self, path, data, cookie='', marker=True):
        headers = {'Content-Type': 'application/json', 'Cookie': cookie}
        if marker:
            headers['X-Team-Request'] = 'employee'
        request = Request(self.base + '/api/employee/' + path,
                          data=json.dumps(data).encode(), headers=headers)
        try:
            with urlopen(request) as response:
                return json.load(response), response.headers.get('Set-Cookie', '').split(';')[0]
        except HTTPError as error:
            error.close()
            raise

    def get(self, path, cookie=''):
        try:
            with urlopen(Request(self.base + path, headers={'Cookie': cookie})) as response:
                return response.read(), response.headers
        except HTTPError as error:
            error.close()
            raise

    def payload(self, body=PNG):
        return {'task_id': self.task, 'status': '正常推进', 'detail': '界面截图',
                'images': [{'name': '进展.png', 'data': base64.b64encode(body).decode()}]}

    def test_round_trip_restart_and_permissions(self):
        payload = self.payload()
        payload['images'] *= 2
        self.post('heartbeat', payload, self.worker)
        app.initialize_database()  # Reinitialization preserves old reports and blobs.
        profile = json.loads(self.get('/api/employee/me', self.worker)[0])
        images = profile['progress'][0]['images']
        self.assertEqual(len(images), 2)
        self.assertNotEqual(images[0]['id'], images[1]['id'])
        self.assertEqual(app.dashboard_data()['progress_updates'][0]['images'], images)
        url = '/api/report-images/' + images[0]['id']
        for cookie in (self.worker, self.owner):
            body, headers = self.get(url, cookie)
            self.assertEqual(body, PNG)
            self.assertEqual(headers['Content-Type'], 'image/png')
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            downloaded_body, downloaded_headers = self.get(url + '?download=1', cookie)
            self.assertEqual(downloaded_body, PNG)
            self.assertIn('attachment', downloaded_headers['Content-Disposition'])
            self.assertIn('%E8%BF%9B%E5%B1%95.png', downloaded_headers['Content-Disposition'])
        for cookie, status in (('', 401), (self.other, 404)):
            with self.assertRaises(HTTPError) as caught:
                self.get(url, cookie)
            self.assertEqual(caught.exception.code, status)

    def test_task_image_can_be_viewed_and_downloaded(self):
        self.post('action', {
            'action': 'work_finish_task',
            'args': {
                'task_id': self.task,
                'summary': '提交带截图的完成说明',
                'attachments': [{
                    'name': '任务截图.png',
                    'contentType': 'image/png',
                    'data': base64.b64encode(PNG).decode(),
                }],
            },
        }, self.worker)
        with app.connect() as db:
            attachment_id = db.execute(
                "SELECT id FROM task_attachments WHERE task_id=? ORDER BY rowid DESC LIMIT 1",
                (self.task,),
            ).fetchone()[0]
        url = '/api/task-files/' + attachment_id
        body, headers = self.get(url, self.worker)
        self.assertEqual(body, PNG)
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertNotIn('Content-Disposition', headers)
        body, headers = self.get(url + '?download=1', self.worker)
        self.assertEqual(body, PNG)
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertIn('%E4%BB%BB%E5%8A%A1%E6%88%AA%E5%9B%BE.png', headers['Content-Disposition'])

    def test_invalid_batch_rolls_back_and_text_still_works(self):
        payload = self.payload()
        payload['images'].append({'name': 'fake.png', 'data': base64.b64encode(b'<svg onload="alert(1)"/>').decode()})
        with self.assertRaises(HTTPError) as caught:
            self.post('heartbeat', payload, self.worker)
        self.assertEqual(caught.exception.code, 400)
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM progress_updates').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM progress_images').fetchone()[0], 0)
        self.post('heartbeat', {'task_id': self.task, 'status': '正常推进'}, self.worker)
        self.assertEqual(app.dashboard_data()['progress_updates'][0]['images'], [])

    def test_auth_and_task_owner_required(self):
        for cookie, marker, code in (('', True, 401), (self.worker, False, 403), (self.other, True, 400)):
            with self.assertRaises(HTTPError) as caught:
                self.post('heartbeat', self.payload(), cookie, marker)
            self.assertEqual(caught.exception.code, code)

    def test_limits_and_bad_encoding(self):
        image = self.payload()['images'][0]
        for images in (None, {}, [image] * 7, [{'data': '!!!'}], [{'data': ''}], [None]):
            with self.assertRaises(ValueError):
                report_images.decode_images(images)
        with patch.object(report_images, 'MAX_IMAGE_BYTES', len(PNG) - 1):
            with self.assertRaises(ValueError):
                report_images.decode_images([image])
        with patch.object(report_images, 'MAX_TOTAL_BYTES', len(PNG)):
            with self.assertRaises(ValueError):
                report_images.decode_images([image, image])
        with patch.object(report_images, 'MAX_REQUEST_BYTES', 32), patch.object(report_files, 'MAX_REQUEST_BYTES', 32):
            with self.assertRaises(HTTPError) as caught:
                self.post('heartbeat', self.payload(), self.worker)
            self.assertEqual(caught.exception.code, 400)


if __name__ == '__main__':
    unittest.main()
