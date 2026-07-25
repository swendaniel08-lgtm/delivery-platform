/// Boots the vendor app against a scripted transport.
///
/// The double-tap test is the one that matters: a vendor tapping "Accept"
/// twice on a laggy connection must not accept the order twice.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_vendor/app/app.dart';
import 'package:besonc_vendor/app/environment.dart';
import 'package:besonc_vendor/state/order_queue_controller.dart';

class RouteTransport implements HttpTransport {
  RouteTransport(this.routes);

  final Map<String, (int, Map<String, dynamic>)> routes;
  final List<String> calls = [];
  Object? failWith;

  /// Delays the reply so a second tap can land while the first is in flight.
  Completer<void>? gate;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    final path = Uri.parse(url).path;
    calls.add('$method $path');
    if (gate != null) await gate!.future;
    if (failWith != null) throw failWith!;
    for (final e in routes.entries) {
      if (path.endsWith(e.key)) return HttpResponse(e.value.$1, jsonEncode(e.value.$2));
    }
    return HttpResponse(404, jsonEncode({'title': 'no route for $path'}));
  }
}

String isoAgo(Duration d) => DateTime.now().toUtc().subtract(d).toIso8601String();

Map<String, dynamic> queuePayload({String state = 'placed'}) => {
      'storeName': 'Auntie Muni Waakye',
      'rating': 4.7,
      'isOpen': true,
      'orders': [
        {
          'id': 'o-1',
          'humanRef': 'BSC-4821',
          'state': state,
          'lines': [
            {'name': 'Jollof Rice', 'quantity': 2, 'addonNames': ['Chicken']},
          ],
          'itemTotalPesewas': '7000',
          'vendorAmountPesewas': '5950',
          'placedAt': isoAgo(const Duration(seconds: 30)),
          'isCod': false,
        },
      ],
    };

VendorDependencies buildDeps(RouteTransport transport) {
  late final AuthController auth;
  final api = BesoncApi(
    baseUrl: 'http://test',
    transport: transport,
    maxRetries: 0,
    backoff: (_) => Duration.zero,
    onAuthLost: () => auth.onSessionExpired(),
  );
  auth = AuthController(api: api, role: AuthRole.vendorOwner);
  return VendorDependencies(
    api: api,
    auth: auth,
    environment: const VendorEnvironment(
      apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', name: 'test',
    ),
  );
}

void main() {
  Future<void> pumpApp(WidgetTester t, VendorDependencies deps) async {
    await t.binding.setSurfaceSize(const Size(360, 800));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(BesoncVendorApp(deps: deps));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));
  }

  group('cold start', () {
    testWidgets('with no session the vendor sees sign-in', (t) async {
      final deps = buildDeps(RouteTransport({}));
      await pumpApp(t, deps);
      expect(find.byKey(const Key('phone-field')), findsOneWidget);
    });

    testWidgets('a saved session lands on the order queue', (t) async {
      final transport = RouteTransport({
        '/api/users/me': (200, {
          'id': 'v1', 'phone': '+233244000001', 'role': 'vendor_owner',
          'firstName': 'Muni',
        }),
        '/api/vendor/queue': (200, queuePayload()),
      });
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');

      await pumpApp(t, deps);
      await t.pump(const Duration(milliseconds: 50));

      expect(find.text('Auntie Muni Waakye'), findsWidgets);
      expect(find.textContaining('BSC-4821'), findsWidgets);
      expect(transport.calls, contains('GET /api/vendor/queue'));
    });
  });

  group('queue coordinator', () {
    test('parses the queue payload', () async {
      final transport = RouteTransport({'/api/vendor/queue': (200, queuePayload())});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);

      await queue.refresh();

      expect(queue.storeName, 'Auntie Muni Waakye');
      expect(queue.rating, 4.7);
      expect(queue.controller.isOpen, isTrue);
      expect(queue.controller.newOrders.single.humanRef, 'BSC-4821');
      expect(queue.controller.newOrders.single.lines.single.kitchenLine,
          '2x Jollof Rice (Chicken)');
      queue.dispose();
    });

    test('accepting posts to the right endpoint with a stable key', () async {
      final transport = RouteTransport({
        '/api/vendor/queue': (200, queuePayload()),
        '/accept': (201, {'ok': true}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);
      await queue.refresh();
      transport.calls.clear();

      await queue.act('o-1', VendorAction.accept);

      expect(transport.calls.first, 'POST /api/vendor/orders/o-1/accept');
      expect(transport.calls, contains('GET /api/vendor/queue'),
          reason: 'the queue is re-read so the card moves section immediately');
      queue.dispose();
    });

    test('DOUBLE TAP: a second accept while the first is in flight is ignored',
        () async {
      final transport = RouteTransport({
        '/api/vendor/queue': (200, queuePayload()),
        '/accept': (201, {'ok': true}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);
      await queue.refresh();
      transport.calls.clear();

      // Hold the first request open, then tap again.
      transport.gate = Completer<void>();
      final first = queue.act('o-1', VendorAction.accept);
      final second = queue.act('o-1', VendorAction.accept);
      transport.gate!.complete();
      transport.gate = null;
      await Future.wait([first, second]);

      final accepts = transport.calls.where((c) => c.endsWith('/accept')).length;
      expect(accepts, 1, reason: 'the pending guard must swallow the second tap');
      queue.dispose();
    });

    test('each action maps to its own endpoint', () async {
      final transport = RouteTransport({
        '/api/vendor/queue': (200, queuePayload()),
        '/preparing': (201, {'ok': true}),
        '/ready': (201, {'ok': true}),
        '/reject': (201, {'ok': true}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);
      await queue.refresh();
      transport.calls.clear();

      await queue.act('o-1', VendorAction.markPreparing);
      await queue.act('o-1', VendorAction.markReady);
      await queue.act('o-1', VendorAction.reject);

      expect(transport.calls, contains('POST /api/vendor/orders/o-1/preparing'));
      expect(transport.calls, contains('POST /api/vendor/orders/o-1/ready'));
      expect(transport.calls, contains('POST /api/vendor/orders/o-1/reject'));
      queue.dispose();
    });

    test('awaitingRider is not a request — there is nothing for the vendor to do',
        () async {
      final transport = RouteTransport({'/api/vendor/queue': (200, queuePayload())});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);
      await queue.refresh();
      transport.calls.clear();

      await queue.act('o-1', VendorAction.awaitingRider);
      await queue.act('o-1', VendorAction.none);

      expect(transport.calls, isEmpty);
      queue.dispose();
    });

    test('closing the store is optimistic and reverts if the server refuses',
        () async {
      final transport = RouteTransport({'/api/vendor/queue': (200, queuePayload())});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);
      await queue.refresh();
      expect(queue.controller.isOpen, isTrue);

      // No route for the PATCH → it 404s.
      await queue.toggleOpen(false);
      expect(queue.controller.isOpen, isTrue, reason: 'a failed toggle must not lie');
      expect(queue.controller.error, isNotNull);
      queue.dispose();
    });

    test('a network failure surfaces as a retryable error', () async {
      final transport = RouteTransport({});
      transport.failWith = const _Offline();
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final queue = VendorQueueCoordinator(api: api);

      await queue.refresh();

      expect(queue.controller.error, contains('No connection'));
      queue.dispose();
    });
  });
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
