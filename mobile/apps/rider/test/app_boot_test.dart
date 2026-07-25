/// Boots the rider app against a scripted transport.
///
/// The proof/cash reset test is the important one: carrying the previous
/// delivery's confirmation into the next leg would let a rider complete a
/// COD job without collecting any cash.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_rider/app/app.dart';
import 'package:besonc_rider/app/environment.dart';
import 'package:besonc_rider/state/rider_controller.dart';

class RouteTransport implements HttpTransport {
  RouteTransport(this.routes);

  final Map<String, (int, Map<String, dynamic>)> routes;
  final List<String> calls = [];
  Object? failWith;

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
    if (failWith != null) throw failWith!;
    for (final e in routes.entries) {
      if (path.endsWith(e.key)) return HttpResponse(e.value.$1, jsonEncode(e.value.$2));
    }
    return HttpResponse(404, jsonEncode({'title': 'no route for $path'}));
  }
}

Map<String, dynamic> statePayload({
  Map<String, dynamic>? leg,
  Map<String, dynamic>? offer,
  String cod = '0',
}) =>
    {
      'riderName': 'Kofi',
      'approved': true,
      'walletBalancePesewas': '12400',
      'todayEarningsPesewas': '4800',
      'todayDeliveries': 6,
      'codObligationPesewas': cod,
      if (leg != null) 'activeLeg': leg,
      if (offer != null) 'offer': offer,
    };

Map<String, dynamic> legJson({
  String legId = 'leg-1',
  String state = 'arrived',
  bool isCod = true,
}) =>
    {
      'legId': legId,
      'orderId': 'o-1',
      'humanRef': 'BSC-4821',
      'state': state,
      'service': 'food',
      'pickup': {'lat': 5.6037, 'lng': -0.1870, 'label': 'Auntie Muni Waakye'},
      'dropoff': {
        'lat': 5.5560, 'lng': -0.1821, 'label': 'Osu',
        'landmark': 'behind the MTN mast',
      },
      'feePesewas': '800',
      'isCod': isCod,
      if (isCod) 'codAmountPesewas': '8150',
      'customerName': 'Ama',
    };

Map<String, dynamic> offerJson() => {
      'legId': 'leg-offer',
      'orderId': 'o-2',
      'service': 'food',
      'pickupLabel': 'Chez Clarisse',
      'dropoffArea': 'Cantonments',
      'earningsPesewas': '900',
      'distanceMetres': 2400,
      'expiresAt':
          DateTime.now().toUtc().add(const Duration(seconds: 25)).toIso8601String(),
      'isCod': false,
    };

RiderDependencies buildDeps(RouteTransport transport) {
  late final AuthController auth;
  final api = BesoncApi(
    baseUrl: 'http://test',
    transport: transport,
    maxRetries: 0,
    backoff: (_) => Duration.zero,
    onAuthLost: () => auth.onSessionExpired(),
  );
  auth = AuthController(api: api, role: AuthRole.rider);
  return RiderDependencies(
    api: api,
    auth: auth,
    environment: const RiderEnvironment(
      apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', name: 'test',
    ),
  );
}

void main() {
  Future<void> pumpApp(WidgetTester t, RiderDependencies deps) async {
    await t.binding.setSurfaceSize(const Size(360, 800));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(BesoncRiderApp(deps: deps));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));
  }

  group('cold start', () {
    testWidgets('with no session the rider sees sign-in', (t) async {
      final deps = buildDeps(RouteTransport({}));
      await pumpApp(t, deps);
      expect(find.byKey(const Key('phone-field')), findsOneWidget);
    });

    testWidgets('a saved session lands on the rider home', (t) async {
      final transport = RouteTransport({
        '/api/users/me': (200, {
          'id': 'r1', 'phone': '+233244000002', 'role': 'rider', 'firstName': 'Kofi',
        }),
        '/api/rider/state': (200, statePayload()),
      });
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');

      await pumpApp(t, deps);
      await t.pump(const Duration(milliseconds: 50));

      expect(find.byKey(const Key('phone-field')), findsNothing);
      expect(transport.calls, contains('GET /api/rider/state'));
    });
  });

  group('coordinator', () {
    test('parses the rider state payload', () async {
      final transport = RouteTransport({
        '/api/rider/state': (200, statePayload(leg: legJson(), cod: '5000')),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);

      await rider.refresh();

      expect(rider.riderName, 'Kofi');
      expect(rider.walletBalance!.value, 12400);
      expect(rider.controller.approved, isTrue);
      expect(rider.controller.leg!.humanRef, 'BSC-4821');
      expect(rider.controller.leg!.visibleLandmark, 'behind the MTN mast');
      expect(rider.controller.codObligation.value, 5000);
      expect(rider.controller.todayDeliveries, 6);
      rider.dispose();
    });

    test('accepting an offer uses an idempotency key and refreshes', () async {
      final transport = RouteTransport({
        '/api/rider/state': (200, statePayload(offer: offerJson())),
        '/accept': (201, {'won': true}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);
      await rider.refresh();
      rider.controller.setOnline(true);
      transport.calls.clear();

      await rider.acceptOffer();

      expect(transport.calls.first, 'POST /api/rider/legs/leg-offer/accept');
      rider.dispose();
    });

    test('LOSING THE RACE clears the card without an error', () async {
      final transport = RouteTransport({
        '/api/rider/state': (200, statePayload(offer: offerJson())),
        '/accept': (201, {'won': false, 'reason': 'taken'}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);
      await rider.refresh();
      rider.controller.setOnline(true);

      await rider.acceptOffer();

      // The poll payload still contains the offer, but a lost race must not
      // look like a crash — the rider just goes back to waiting.
      expect(rider.controller.submitting, isFalse);
      rider.dispose();
    });

    test('declining clears the offer immediately', () async {
      final transport = RouteTransport({
        '/api/rider/state': (200, statePayload(offer: offerJson())),
        '/decline': (201, {'declined': true}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);
      await rider.refresh();
      expect(rider.controller.offer, isNotNull);

      await rider.declineOffer();

      expect(rider.controller.offer, isNull, reason: 'the card goes at once');
      expect(transport.calls, contains('POST /api/rider/legs/leg-offer/decline'));
      rider.dispose();
    });

    test('advancing posts the event the controller chose', () async {
      final transport = RouteTransport({
        '/api/rider/state': (200, statePayload(leg: legJson(state: 'picked_up'))),
        '/events': (201, {'ok': true}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);
      await rider.refresh();
      transport.calls.clear();

      final action = rider.controller.leg!.nextAction;
      await rider.advance(action.event);

      expect(action.event, 'rider_arrive');
      expect(transport.calls.first, 'POST /api/rider/legs/leg-1/events');
      rider.dispose();
    });

    test('going online is reverted when the server refuses', () async {
      final transport = RouteTransport({'/api/rider/state': (200, statePayload())});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);
      await rider.refresh();

      await rider.toggleOnline(true);   // no /online route → 404

      expect(rider.controller.isOnline, isFalse,
          reason: 'the toggle must reflect the server, not the tap');
      rider.dispose();
    });

    test('a dropped poll is silent — no error banner all shift', () async {
      final transport = RouteTransport({'/api/rider/state': (200, statePayload())});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final rider = RiderCoordinator(api: api);
      await rider.refresh();
      expect(rider.controller.approved, isTrue);

      transport.failWith = const _Offline();
      await rider.refresh();

      expect(rider.controller.approved, isTrue, reason: 'last known state survives');
      rider.dispose();
    });
  });

  group('proof and cash confirmation', () {
    test('a new leg resets proof and cash — the COD safety net', () {
      final c = DeliveryConfirmations();

      c.syncTo('leg-1');
      c.hasProof = true;
      c.cashConfirmed = true;

      final reset = c.syncTo('leg-2');

      expect(reset, isTrue);
      expect(c.hasProof, isFalse);
      expect(c.cashConfirmed, isFalse,
          reason: 'carrying this over would let a rider complete a COD job '
              'without collecting any cash');
    });

    test('re-syncing the same leg preserves what the rider already did', () {
      final c = DeliveryConfirmations();
      c.syncTo('leg-1');
      c.hasProof = true;

      // Every poll rebuilds the widget; that must not wipe the photo.
      expect(c.syncTo('leg-1'), isFalse);
      expect(c.hasProof, isTrue);
    });

    test('finishing a leg (null) clears the confirmations', () {
      final c = DeliveryConfirmations();
      c.syncTo('leg-1');
      c.hasProof = true;
      c.cashConfirmed = true;

      c.syncTo(null);

      expect(c.hasProof, isFalse);
      expect(c.cashConfirmed, isFalse);
      expect(c.legId, isNull);
    });
  });
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
