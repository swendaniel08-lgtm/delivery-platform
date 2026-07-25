import 'dart:convert';
import 'package:test/test.dart';
import 'package:besonc_api/besonc_api.dart';

/// Scriptable transport: queue responses, inspect what was sent.
class FakeTransport implements HttpTransport {
  FakeTransport(this.responses);
  final List<Object> responses; // HttpResponse or Exception
  final List<Map<String, dynamic>> sent = [];
  int _i = 0;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    sent.add({'method': method, 'url': url, 'headers': headers, 'body': body});
    final r = _i < responses.length ? responses[_i] : responses.last;
    _i++;
    if (r is Exception) throw r;
    return r as HttpResponse;
  }
}

HttpResponse ok(Object body) => HttpResponse(200, jsonEncode(body));
HttpResponse problem(int status, Map<String, dynamic> body) =>
    HttpResponse(status, jsonEncode(body));

BesoncApi client(FakeTransport t, {TokenStore? tokens, void Function()? onAuthLost}) =>
    BesoncApi(
      baseUrl: 'https://api.test',
      transport: t,
      tokens: tokens,
      onAuthLost: onAuthLost,
      backoff: (_) => Duration.zero, // no real waiting in tests
    );

void main() {
  group('happy path', () {
    test('GET returns the decoded body', () async {
      final t = FakeTransport([ok({'hello': 'world'})]);
      expect(await client(t).get('/api/customer/home'), {'hello': 'world'});
      expect(t.sent.first['url'], 'https://api.test/api/customer/home');
    });

    test('query parameters are encoded', () async {
      final t = FakeTransport([ok({})]);
      await client(t).get('/search', query: {'q': 'jollof rice'});
      expect(t.sent.first['url'], contains('q=jollof%20rice'));
    });

    test('the bearer token is attached when present', () async {
      final store = InMemoryTokenStore();
      await store.save(access: 'tok-1', refresh: 'ref-1');
      final t = FakeTransport([ok({})]);
      await client(t, tokens: store).get('/me');
      expect((t.sent.first['headers'] as Map)['authorization'], 'Bearer tok-1');
    });
  });

  group('RFC-7807 errors', () {
    test('validation errors expose field detail for the form', () async {
      final t = FakeTransport([
        problem(422, {
          'title': 'Validation Failed', 'status': 422,
          'errors': {'phone': ['not a valid Ghana mobile number']},
        })
      ]);
      try {
        await client(t).post('/api/auth/otp/request', body: {'phone': 'x'});
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.isValidation, isTrue);
        expect(e.errors!['phone']!.first, contains('Ghana mobile'));
      }
    });

    test('the backend message is surfaced, not a generic string', () async {
      final t = FakeTransport([
        problem(409, {
          'title': 'Conflict', 'status': 409,
          'detail': "Your cart has items from Auntie Adwoa's. Start a new cart?",
        })
      ]);
      try {
        await client(t).post('/cart/items', body: {});
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.message, contains("Auntie Adwoa's"));
        expect(e.isConflict, isTrue);
      }
    });

    test('rate limiting carries retry-after', () async {
      final t = FakeTransport([
        problem(429, {'title': 'Too Many Requests', 'status': 429, 'retryAfterSeconds': 42})
      ]);
      try {
        await client(t).get('/x');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.isRateLimited, isTrue);
        expect(e.retryAfterSeconds, 42);
      }
    });

    test('an HTML error page from a proxy does not crash the parser', () async {
      final t = FakeTransport([HttpResponse(502, '<html>Bad Gateway</html>')]);
      try {
        await client(t).get('/x');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.status, 502);
        expect(e.title, 'Request failed');
      }
    });

    test('the correlation id is captured for support', () async {
      final t = FakeTransport([
        problem(500, {'title': 'Internal', 'status': 500, 'correlationId': 'trace-9'})
      ]);
      try {
        await client(t).get('/x');
      } on ApiException catch (e) {
        expect(e.correlationId, 'trace-9');
      }
    });
  });

  group('retries on a bad network', () {
    test('a GET retries and eventually succeeds', () async {
      final t = FakeTransport([
        Exception('socket closed'),
        Exception('socket closed'),
        ok({'ok': true}),
      ]);
      expect(await client(t).get('/x'), {'ok': true});
      expect(t.sent.length, 3);
    });

    test('a GET gives up after maxRetries with a friendly message', () async {
      final t = FakeTransport([Exception('no route to host')]);
      try {
        await client(t).get('/x');
        fail('should have thrown');
      } on NetworkException catch (e) {
        expect(e.message, contains('No connection'));
      }
      expect(t.sent.length, 4); // initial + 3 retries
    });

    test('5xx is retried, 4xx is not', () async {
      final retried = FakeTransport([
        problem(503, {'title': 'Unavailable', 'status': 503}),
        ok({'ok': true}),
      ]);
      expect(await client(retried).get('/x'), {'ok': true});

      final notRetried = FakeTransport([
        problem(404, {'title': 'Not Found', 'status': 404}),
        ok({'ok': true}),
      ]);
      await expectLater(client(notRetried).get('/x'), throwsA(isA<ApiException>()));
      expect(notRetried.sent.length, 1, reason: 'a 404 must not be retried');
    });

    test('a POST is NOT retried without an idempotency key', () async {
      final t = FakeTransport([Exception('timeout'), ok({'ok': true})]);
      await expectLater(
          client(t).post('/orders', body: {}), throwsA(isA<NetworkException>()));
      expect(t.sent.length, 1,
          reason: 'retrying a non-idempotent POST could create two orders');
    });

    test('a POST WITH an idempotency key is retried safely', () async {
      final t = FakeTransport([Exception('timeout'), ok({'id': 'o1'})]);
      final res = await client(t)
          .post('/orders', body: {}, idempotencyKey: 'order-attempt-1');
      expect(res['id'], 'o1');
      expect(t.sent.length, 2);
    });

    test('the SAME idempotency key is reused across retries', () async {
      final t = FakeTransport([Exception('timeout'), Exception('timeout'), ok({})]);
      await client(t).post('/orders', body: {}, idempotencyKey: 'stable-key');
      final keys = t.sent
          .map((s) => (s['headers'] as Map)['idempotency-key'])
          .toSet();
      expect(keys, {'stable-key'},
          reason: 'a new key per attempt would defeat server-side dedupe');
    });
  });

  group('token refresh', () {
    test('a 401 refreshes once and replays the request', () async {
      final store = InMemoryTokenStore();
      await store.save(access: 'expired', refresh: 'ref-1');
      final t = FakeTransport([
        problem(401, {'title': 'Unauthorized', 'status': 401}),
        ok({'accessToken': 'new-access', 'refreshToken': 'new-refresh'}),
        ok({'data': 'protected'}),
      ]);
      expect(await client(t, tokens: store).get('/me'), {'data': 'protected'});
      expect(await store.accessToken(), 'new-access');
      expect((t.sent[2]['headers'] as Map)['authorization'], 'Bearer new-access');
    });

    test('concurrent 401s share ONE refresh, not a stampede', () async {
      final store = InMemoryTokenStore();
      await store.save(access: 'expired', refresh: 'ref-1');
      final t = FakeTransport([
        problem(401, {'title': 'Unauthorized', 'status': 401}),
        problem(401, {'title': 'Unauthorized', 'status': 401}),
        problem(401, {'title': 'Unauthorized', 'status': 401}),
        ok({'accessToken': 'new', 'refreshToken': 'new-r'}),
        ok({'n': 1}), ok({'n': 2}), ok({'n': 3}),
      ]);
      final api = client(t, tokens: store);
      await Future.wait([api.get('/a'), api.get('/b'), api.get('/c')]);

      final refreshCalls =
          t.sent.where((s) => (s['url'] as String).contains('/auth/refresh')).length;
      expect(refreshCalls, 1, reason: 'three 401s must not trigger three refreshes');
    });

    test('a rejected refresh clears tokens and signals the app', () async {
      final store = InMemoryTokenStore();
      await store.save(access: 'expired', refresh: 'dead');
      var authLost = false;
      final t = FakeTransport([
        problem(401, {'title': 'Unauthorized', 'status': 401}),
        problem(401, {'title': 'Session revoked', 'status': 401}),
        problem(401, {'title': 'Unauthorized', 'status': 401}),
      ]);
      await expectLater(
        client(t, tokens: store, onAuthLost: () => authLost = true).get('/me'),
        throwsA(isA<ApiException>()),
      );
      expect(authLost, isTrue);
      expect(await store.accessToken(), isNull);
    });

    test('a NETWORK failure during refresh must not log the user out', () async {
      final store = InMemoryTokenStore();
      await store.save(access: 'expired', refresh: 'ref-1');
      final t = FakeTransport([
        problem(401, {'title': 'Unauthorized', 'status': 401}),
        Exception('tunnel'), // refresh call fails at the socket
        problem(401, {'title': 'Unauthorized', 'status': 401}),
      ]);
      await expectLater(client(t, tokens: store).get('/me'),
          throwsA(isA<ApiException>()));
      expect(await store.refreshToken(), 'ref-1',
          reason: 'a user in a tunnel must stay signed in');
    });
  });

  group('idempotency keys', () {
    test('are unique per invocation', () {
      final api = client(FakeTransport([ok({})]));
      final a = api.idempotencyKeyFor('checkout', 'cart-1');
      final b = api.idempotencyKeyFor('checkout', 'cart-1');
      expect(a, isNot(b));
      expect(a, startsWith('checkout:cart-1:'));
    });
  });
}
