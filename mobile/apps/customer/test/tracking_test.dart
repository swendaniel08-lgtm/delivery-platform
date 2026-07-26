/// Live tracking — the screen a customer stares at in Accra traffic.
///
/// The behaviour that matters is what happens when the network misbehaves,
/// because on Ghanaian mobile data it always does. A frozen dot with a
/// "Live" badge is worse than no tracking at all: the customer cannot tell
/// "stuck at a light" from "the app died".

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/screens/tracking_screen.dart';
// Prefixed: Flutter also exports a `ConnectionState`.
import 'package:besonc_customer/state/tracking_controller.dart' as tracking;
import 'package:besonc_customer/state/tracking_controller.dart'
    show TrackingController;
import 'package:besonc_customer/state/tracking_session.dart';

class RouteTransport implements HttpTransport {
  RouteTransport(this.body);
  Map<String, dynamic> body;
  final List<String> calls = [];
  Object? failWith;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? requestBody,
    String? body,
    Duration? timeout,
  }) async {
    calls.add('$method ${Uri.parse(url).path}');
    if (failWith != null) throw failWith!;
    return HttpResponse(200, jsonEncode(this.body));
  }
}

/// A socket we can break on demand.
class FakeStream implements PositionStream {
  final List<StreamController<Map<String, dynamic>>> opened = [];
  int connects = 0;
  bool closed = false;

  @override
  Stream<Map<String, dynamic>> connect(String orderId, String token) {
    connects += 1;
    final c = StreamController<Map<String, dynamic>>();
    opened.add(c);
    return c.stream;
  }

  StreamController<Map<String, dynamic>> get current => opened.last;

  void emit(Map<String, dynamic> frame) => current.add(frame);
  void drop() => current.addError(Exception('socket closed'));

  @override
  Future<void> close() async {
    closed = true;
    for (final c in opened) {
      if (!c.isClosed) await c.close();
    }
  }
}

void main() {
  group('honesty about staleness', () {
    test('a fresh fix reads Live', () {
      var now = DateTime(2026, 7, 26, 12, 0, 0);
      final c = TrackingController(
        orderId: 'o1', initialState: OrderState.inTransit, clock: () => now,
      )..onConnected();

      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 600);
      expect(c.connectionLabel, 'Live');
      expect(c.positionIsStale, isFalse);
    });

    test('A STALE DOT SAYS SO instead of claiming Live', () {
      var now = DateTime(2026, 7, 26, 12, 0, 0);
      final c = TrackingController(
        orderId: 'o1', initialState: OrderState.inTransit, clock: () => now,
      )..onConnected();
      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 600);

      now = now.add(const Duration(seconds: 90));

      expect(c.positionIsStale, isTrue);
      expect(c.connectionLabel, contains('Last seen'),
          reason: 'a frozen dot labelled Live is worse than no tracking');
    });

    test('a very stale fix stops guessing the ETA entirely', () {
      var now = DateTime(2026, 7, 26, 12, 0, 0);
      final c = TrackingController(
        orderId: 'o1', initialState: OrderState.inTransit, clock: () => now,
      )..onConnected();
      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 600);

      now = now.add(const Duration(minutes: 5));

      expect(c.etaSeconds, isNull,
          reason: 'counting down from a five-minute-old reading is fiction');
      expect(c.connectionLabel, contains('Reconnecting'));
    });

    test('the ETA counts down between updates but never below zero', () {
      var now = DateTime(2026, 7, 26, 12, 0, 0);
      final c = TrackingController(
        orderId: 'o1', initialState: OrderState.inTransit, clock: () => now,
      )..onConnected();
      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 30);

      now = now.add(const Duration(seconds: 20));
      expect(c.etaSeconds, 10);

      now = now.add(const Duration(seconds: 20));
      expect(c.etaSeconds, 0, reason: 'a negative ETA is nonsense on screen');
      expect(c.etaLabel, 'Arriving now');
    });

    test('the ETA is coarse — precision invites complaints', () {
      var now = DateTime(2026, 7, 26, 12);
      final c = TrackingController(
        orderId: 'o1', initialState: OrderState.inTransit, clock: () => now,
      )..onConnected();

      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 1080);
      expect(c.etaLabel, 'About 20 minutes',
          reason: 'promising "18 minutes" to the second is a complaint waiting');
    });
  });

  group('the session keeps the screen fed', () {
    ({TrackingSession session, TrackingController controller,
      RouteTransport transport, FakeStream stream}) harness() {
      final transport = RouteTransport({
        'position': {'lat': 5.58, 'lng': -0.19},
        'etaSeconds': 600,
        'state': 'in_transit',
      });
      final controller = TrackingController(
        orderId: 'o1', initialState: OrderState.riderAssigned,
      );
      final stream = FakeStream();
      return (
        session: TrackingSession(
          api: BesoncApi(
            baseUrl: 'http://t', transport: transport, maxRetries: 0,
            backoff: (_) => Duration.zero,
          ),
          controller: controller,
          stream: stream,
          pollInterval: const Duration(milliseconds: 40),
          backoff: (_) => const Duration(milliseconds: 10),
        ),
        controller: controller,
        transport: transport,
        stream: stream,
      );
    }

    test('it polls IMMEDIATELY so the map is never blank', () async {
      final h = harness();
      await h.session.start('token');
      addTearDown(h.session.stop);

      expect(h.transport.calls, isNotEmpty,
          reason: 'waiting a full interval leaves the customer staring at nothing');
      expect(h.controller.rider, isNotNull);
      expect(h.controller.state, OrderState.inTransit);
    });

    test('a socket frame updates the position', () async {
      final h = harness();
      await h.session.start('token');
      addTearDown(h.session.stop);

      h.stream.emit({
        'position': {'lat': 5.57, 'lng': -0.185},
        'etaSeconds': 300,
        'state': 'in_transit',
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(h.controller.rider!.position.lat, closeTo(5.57, 1e-6));
      expect(h.controller.connection, tracking.ConnectionState.live);
    });

    test('A DROPPED SOCKET DEGRADES, it does not freeze', () async {
      final h = harness();
      await h.session.start('token');
      addTearDown(h.session.stop);

      h.stream.drop();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(h.controller.connection, tracking.ConnectionState.degraded,
          reason: 'polling is still running, so the screen still updates');

      // …and it reconnects.
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(h.stream.connects, greaterThan(1));
    });

    test('polling continues while the socket is down', () async {
      final h = harness();
      await h.session.start('token');
      addTearDown(h.session.stop);

      h.stream.drop();
      final before = h.transport.calls.length;
      await Future<void>.delayed(const Duration(milliseconds: 120));

      expect(h.transport.calls.length, greaterThan(before),
          reason: 'the fallback is the whole point of having one');
    });

    test('a failed poll does not blank the screen', () async {
      final h = harness();
      await h.session.start('token');
      addTearDown(h.session.stop);
      final position = h.controller.rider!.position;

      h.transport.failWith = const _Offline();
      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(h.controller.rider!.position.lat, position.lat,
          reason: 'the last known position stays; the badge goes stale');
    });

    test('DELIVERY STOPS THE POLLING', () async {
      final h = harness();
      await h.session.start('token');

      h.stream.emit({'state': 'delivered'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final after = h.transport.calls.length;

      await Future<void>.delayed(const Duration(milliseconds: 120));

      expect(h.controller.state, OrderState.delivered);
      expect(h.transport.calls.length, after,
          reason: 'polling a finished delivery eats the customer\'s data bundle');
    });

    test('stop() really stops everything', () async {
      final h = harness();
      await h.session.start('token');
      await h.session.stop();

      final after = h.transport.calls.length;
      await Future<void>.delayed(const Duration(milliseconds: 120));

      expect(h.transport.calls.length, after);
      expect(h.stream.closed, isTrue);
    });

    test('with no socket transport, polling alone still works', () async {
      final transport = RouteTransport({
        'position': {'lat': 5.58, 'lng': -0.19}, 'state': 'in_transit',
      });
      final controller = TrackingController(
        orderId: 'o1', initialState: OrderState.riderAssigned,
      );
      final session = TrackingSession(
        api: BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0),
        controller: controller,
        pollInterval: const Duration(milliseconds: 40),
      );
      await session.start('token');
      addTearDown(session.stop);

      expect(controller.rider, isNotNull);
      expect(controller.connection, tracking.ConnectionState.live,
          reason: 'slower, but entirely correct');
    });
  });

  /* ---------------------------------------------------------------- */

  group('the screen', () {
    Future<void> pump(WidgetTester t, Widget child) async {
      await t.binding.setSurfaceSize(const Size(360, 740));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(MaterialApp(home: child));
      await t.pump();
    }

    TrackingController at(OrderState state, {DateTime Function()? clock}) =>
        TrackingController(orderId: 'o1', initialState: state, clock: clock);

    /* -------------------------------------------------------------- */
    /* The live map                                                    */
    /* -------------------------------------------------------------- */

    const osu = LatLng(5.5560, -0.1821);
    const accraMall = LatLng(5.6206, -0.1730);

    testWidgets('NO map while the food is still being cooked', (t) async {
      // A stationary dot at the vendor answers nothing. "Being prepared" is
      // the answer at this stage, and the map would only be noise.
      final c = at(OrderState.preparing)..onConnected();
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1', destination: accraMall,
      ));
      expect(find.byKey(const Key('tracking-map')), findsNothing);
    });

    testWidgets('the map appears once the rider is genuinely moving',
        (t) async {
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..onPosition(osu, etaSeconds: 480);
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1', destination: accraMall,
      ));
      expect(find.byKey(const Key('tracking-map')), findsOneWidget);
      expect(t.takeException(), isNull);
    });

    testWidgets('no destination pin means no map, not a broken one',
        (t) async {
      // Older orders and upstreams without a pin must degrade to the
      // progress trail rather than rendering a map to nowhere.
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..onPosition(osu);
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-1'));
      expect(find.byKey(const Key('tracking-map')), findsNothing);
      expect(find.byKey(const Key('step-0')), findsOneWidget);
      expect(t.takeException(), isNull);
    });

    testWidgets('the map and the header agree about staleness', (t) async {
      // If the header says "last seen 4 min ago" while the map shows a
      // confident live dot, the customer believes the map and goes to the
      // gate too early. Both must read from the same controller.
      var now = DateTime(2026, 7, 26, 12);
      final c = TrackingController(
        orderId: 'o1', initialState: OrderState.inTransit, clock: () => now,
      )
        ..onConnected()
        ..onPosition(osu);

      now = now.add(const Duration(minutes: 5));
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1', destination: accraMall,
      ));

      expect(c.positionIsVeryStale, isTrue);
      expect(find.byKey(const Key('map-position-lost')), findsOneWidget);
      expect(find.byKey(const Key('map-distance')), findsNothing);
    });

    testWidgets('the map does not overflow at 360dp', (t) async {
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..onPosition(osu, etaSeconds: 900);
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1',
        destination: accraMall, pickup: osu,
      ));
      expect(t.takeException(), isNull);
    });

    testWidgets('shows a pickup pin before collection', (t) async {
      final c = at(OrderState.pickedUp)
        ..onConnected()
        ..onPosition(osu, etaSeconds: 600);
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1',
        destination: accraMall, pickup: osu,
      ));
      expect(find.byKey(const Key('tracking-map')), findsOneWidget);
      expect(t.takeException(), isNull);
    });

    testWidgets('the map disappears when the order completes', (t) async {
      // A delivered order has nothing to track, and a lingering map implies
      // the rider is still coming.
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..onPosition(osu);
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1', destination: accraMall,
      ));
      expect(find.byKey(const Key('tracking-map')), findsOneWidget);

      c.onStateChanged(OrderState.delivered);
      await t.pump();
      expect(find.byKey(const Key('tracking-map')), findsNothing);
    });

    testWidgets('shows the state, the trail and the reference', (t) async {
      final c = at(OrderState.preparing)..onConnected();
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-4821'));

      expect(find.text('BSC-4821'), findsOneWidget);
      expect(find.byKey(const Key('tracking-state')), findsOneWidget);
      expect(find.text('Being prepared'), findsWidgets);
      expect(find.byKey(const Key('step-0')), findsOneWidget);
      expect(find.byKey(const Key('step-5')), findsOneWidget);
    });

    testWidgets('THE BADGE IS HONEST when the fix is stale', (t) async {
      var now = DateTime(2026, 7, 26, 12);
      final c = at(OrderState.inTransit, clock: () => now)..onConnected();
      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 600);

      now = now.add(const Duration(minutes: 2));
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-1'));

      expect(find.textContaining('Last seen'), findsOneWidget);
      expect(find.text('Live'), findsNothing);
    });

    testWidgets('the rider card appears once a rider is assigned', (t) async {
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..setRider(name: 'Kofi', vehicle: 'Motorbike');
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-1'));

      expect(find.byKey(const Key('rider-name')), findsOneWidget);
      expect(find.text('Kofi'), findsOneWidget);
      expect(find.byKey(const Key('call-rider')), findsOneWidget);
    });

    testWidgets('unread messages are badged', (t) async {
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..setRider(name: 'Kofi')
        ..setUnreadMessages(3);
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-1'));

      expect(find.byKey(const Key('unread-dot')), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
    });

    testWidgets('no rider card before one is assigned', (t) async {
      final c = at(OrderState.preparing)..onConnected();
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-1'));
      expect(find.byKey(const Key('rider-name')), findsNothing);
    });

    testWidgets('cancel is offered early and withdrawn later', (t) async {
      final early = at(OrderState.placed)..onConnected();
      await pump(t, TrackingScreen(controller: early, humanRef: 'BSC-1'));
      expect(find.byKey(const Key('cancel-order')), findsOneWidget);

      final late_ = at(OrderState.inTransit)..onConnected();
      await pump(t, TrackingScreen(controller: late_, humanRef: 'BSC-1'));
      expect(find.byKey(const Key('cancel-order')), findsNothing,
          reason: 'the food is already on a motorbike');
    });

    testWidgets('THE 50% WARNING IS SHOWN BEFORE the tap is committed',
        (t) async {
      final c = at(OrderState.preparing)..onConnected();
      var cancelled = false;
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1', onCancel: () => cancelled = true,
      ));

      await t.tap(find.byKey(const Key('cancel-order')));
      await t.pumpAndSettle();

      expect(find.textContaining('refunded 50%'), findsOneWidget,
          reason: 'a customer must know the cost before confirming, not after');

      await t.tap(find.byKey(const Key('cancel-keep')));
      await t.pumpAndSettle();
      expect(cancelled, isFalse, reason: 'backing out must not cancel');
    });

    testWidgets('confirming actually cancels', (t) async {
      final c = at(OrderState.placed)..onConnected();
      var cancelled = false;
      await pump(t, TrackingScreen(
        controller: c, humanRef: 'BSC-1', onCancel: () => cancelled = true,
      ));

      await t.tap(find.byKey(const Key('cancel-order')));
      await t.pumpAndSettle();
      expect(find.textContaining('refunded in full'), findsOneWidget);

      await t.tap(find.byKey(const Key('cancel-confirm')));
      await t.pumpAndSettle();
      expect(cancelled, isTrue);
    });

    testWidgets('a delivered order shows the finished trail', (t) async {
      final c = at(OrderState.delivered)..onConnected();
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-1'));

      expect(find.byKey(const Key('cancel-order')), findsNothing);
      expect(find.byIcon(Icons.check_circle), findsWidgets);
    });

    testWidgets('fits a 360dp phone without overflow', (t) async {
      final c = at(OrderState.inTransit)
        ..onConnected()
        ..setRider(name: 'Kwame Asante-Boateng', vehicle: 'Motorbike')
        ..setUnreadMessages(12);
      c.onPosition(const LatLng(5.58, -0.19), etaSeconds: 900);
      await pump(t, TrackingScreen(controller: c, humanRef: 'BSC-4821'));

      final e = t.takeException();
      expect(e == null || !e.toString().contains('overflowed'), isTrue);
    });
  });
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
