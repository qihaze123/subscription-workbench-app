import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from backend.app import handler_for
from backend.distribution import load_config, start_server, token_for
from backend.store import Store


class FunnelSharingTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Store(Path(temp.name) / 'workbench.sqlite3')
        self.addCleanup(self.store.close)
        self.config = {
            'enabled': True,
            'hostname': 'workbench.example.ts.net',
            'secret': '01' * 32,
            'desktopToken': '23' * 32,
            'httpsPort': 8443,
            'listenPort': 0,
            'funnel': {'listenPort': 0, 'httpsPort': 10000},
        }
        self.origin = 'https://workbench.example.ts.net:9443'
        self.admin_headers = {'Host': 'workbench.example.ts.net:9443', 'Origin': self.origin,
                              'Tailscale-User-Login': 'operator@example.com'}
        admin = handler_for(self.store, distribution=self.config,
                            tailnet_admin=(self.origin, {'operator@example.com'}))
        self.admin = self.serve(ThreadingHTTPServer(('127.0.0.1', 0), admin))
        self.private = self.serve(start_server(self.store, self.config))
        self.public = self.serve(start_server(self.store, self.config, public=True))
        self.create('guest-one', published=True)
        self.create('guest-two', published=True)
        self.create('draft', published=False)

    def create(self, profile_id, published):
        template = json.loads(self.store._row('desktop')['body'])
        profile = self.store.create({**template, 'id': profile_id, 'name': profile_id})
        if published:
            self.store.publish(profile_id, profile['revision'])

    def serve(self, server):
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port

    def request(self, port, path, method='GET', payload=None, headers=None):
        connection = HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            headers = dict(headers or {})
            if payload is not None:
                headers['Content-Type'] = 'application/json'
            connection.request(method, path, json.dumps(payload) if payload is not None else None, headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def toggle(self, pid, enabled):
        status, body = self.request(self.admin, '/api/distribution/share', 'POST',
                                    {'profileId': pid, 'enabled': enabled}, self.admin_headers)
        return status, json.loads(body)

    def private_path(self, profile_id):
        return f'/s/{profile_id}/{token_for(self.config, profile_id)}.yaml'

    def test_public_enable_and_revoke_above_private_routes(self):
        status, body = self.request(self.admin, '/api/distribution/share?profileId=guest-one',
                                    headers=self.admin_headers)
        self.assertEqual((status, json.loads(body)), (200, {'allowed': True, 'enabled': False}))
        status, share = self.toggle('guest-one', True)
        self.assertEqual(status, 200)
        self.assertTrue(share['enabled'])
        self.assertEqual(self.toggle('guest-one', True)[1], share)
        link = urlsplit(share['url'])
        self.assertEqual((link.scheme, link.port), ('https', 10000))
        self.assertEqual(self.request(self.public, link.path), self.request(self.private, self.private_path('guest-one')))
        self.assertEqual(self.request(self.public, link.path, 'HEAD'), (200, b''))
        self.assertEqual(self.request(self.private, link.path)[0], 404)
        self.assertEqual(self.request(self.public, link.path.replace('guest-one', 'guest-two'))[0], 404)
        self.assertEqual(self.request(self.public, self.private_path('guest-one').replace('/s/', '/share/'))[0], 404)
        self.assertEqual(self.toggle('guest-one', False)[0], 200)
        self.assertEqual(self.request(self.public, link.path)[0], 404)
        new_link = urlsplit(self.toggle('guest-one', True)[1]['url']).path
        self.assertNotEqual(new_link, link.path)
        self.assertEqual(self.request(self.public, new_link)[0], 200)
        self.assertEqual(self.request(self.public, link.path)[0], 404)
        self.assertEqual(self.request(self.private, self.private_path('guest-one'))[0], 200)

    def test_protected_unpublished_and_unauthorized_subscriptions(self):
        for profile_id in ('desktop', 'phone'):
            self.assertEqual(self.toggle(profile_id, True)[0], 403)
            self.assertEqual(self.request(self.private, self.private_path(profile_id))[0], 200)
            self.assertEqual(self.request(self.public, self.private_path(profile_id))[0], 404)
        self.assertEqual(self.toggle('draft', True)[0], 409)
        for path in ('/', '/api/data', '/api/distribution/share', '/subscriptions/desktop.yaml'):
            self.assertEqual(self.request(self.public, path)[0], 404)
        path = '/api/distribution/share'
        data = {'profileId': 'guest-two', 'enabled': True}
        for headers in ({'Host': self.admin_headers['Host'], 'Origin': self.origin},
                        {**self.admin_headers, 'Origin': 'https://other.example'}):
            self.assertEqual(self.request(self.admin, path, 'POST', data, headers)[0], 403)
        self.assertEqual(self.request(self.public, path, 'POST', data)[0], 405)

    def test_deleting_a_profile_revokes_the_public_link(self):
        _, share = self.toggle('guest-one', True)
        link = urlsplit(share['url']).path
        self.store.delete('guest-one', self.store._row('guest-one')['revision'])
        self.create('guest-one', published=True)
        self.assertEqual(self.request(self.public, link)[0], 404)

    def test_configuration_rejects_reusing_either_private_port(self):
        config = {**self.config, 'listenPort': 18862, 'funnel': {'listenPort': 18864, 'httpsPort': 10000}}
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'distribution.json'
        path.write_text(json.dumps(config))
        self.assertEqual(load_config(path), config)
        for field in ('listenPort', 'httpsPort'):
            path.write_text(json.dumps({**config, 'funnel': {**config['funnel'], field: config[field]}}))
            with self.assertRaises(ValueError):
                load_config(path)
