/// Menu management — marking a dish sold out, fast.
///
/// The optimistic revert is the part that matters. A toggle that LOOKS like
/// it worked but did not means the kitchen keeps receiving orders it cannot
/// cook, and the vendor does not find out until a customer complains.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_vendor/screens/menu_screen.dart';
import 'package:besonc_vendor/state/menu_controller.dart';

class RouteTransport implements HttpTransport {
  RouteTransport(this.routes);
  final Map<String, (int, Map<String, dynamic>)> routes;
  final List<String> calls = [];
  final List<String> bodies = [];
  Object? failWith;
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
    if (body != null) bodies.add(body);
    if (gate != null) await gate!.future;
    if (failWith != null) throw failWith!;

    var bestLen = -1;
    int? status;
    Map<String, dynamic>? payload;
    for (final e in routes.entries) {
      final parts = e.key.split(' ');
      if (parts[0] != method || !path.endsWith(parts[1])) continue;
      if (parts[1].length > bestLen) {
        bestLen = parts[1].length;
        status = e.value.$1;
        payload = e.value.$2;
      }
    }
    if (status != null) return HttpResponse(status, jsonEncode(payload));
    return HttpResponse(404, jsonEncode({'title': 'no route for $path'}));
  }
}

Map<String, dynamic> menuPayload() => {
      'items': [
        {'id': 'i1', 'name': 'Jollof Rice', 'basePricePesewas': '3500',
          'isAvailable': true},
        {'id': 'i2', 'name': 'Grilled Tilapia', 'basePricePesewas': '6000',
          'isAvailable': false},
      ],
    };

({VendorMenuController menu, RouteTransport transport}) harness() {
  final transport = RouteTransport({
    'GET /api/vendor/menu': (200, menuPayload()),
    'PATCH /api/vendor/menu/i1/availability': (200, {
      'id': 'i1', 'name': 'Jollof Rice', 'isAvailable': false,
    }),
    'POST /api/vendor/menu': (201, {'id': 'i3', 'name': 'Waakye'}),
  });
  return (
    menu: VendorMenuController(
      api: BesoncApi(
        baseUrl: 'http://t', transport: transport, maxRetries: 0,
        backoff: (_) => Duration.zero,
      ),
    ),
    transport: transport,
  );
}

void main() {
  group('loading', () {
    test('the menu includes items the vendor switched off', () async {
      final h = harness();
      await h.menu.load();

      expect(h.menu.state, MenuLoad.ready);
      expect(h.menu.items, hasLength(2));
      expect(h.menu.items[1].isAvailable, isFalse);
      expect(h.menu.soldOutCount, 1,
          reason: 'hiding them would leave the vendor unable to switch them on');
    });

    test('prices parse as pesewas', () async {
      final h = harness();
      await h.menu.load();
      expect(h.menu.items.first.price.value, 3500);
      expect(h.menu.items.first.price.display, 'GHS 35.00');
    });

    test('a failed first load shows the error screen', () async {
      final h = harness();
      h.transport.failWith = const _Offline();
      await h.menu.load();

      expect(h.menu.state, MenuLoad.failed);
      expect(h.menu.error, contains('No connection'));
    });

    test('a failed REFRESH keeps the menu on screen', () async {
      final h = harness();
      await h.menu.load();

      h.transport.failWith = const _Offline();
      await h.menu.load();

      expect(h.menu.state, MenuLoad.ready);
      expect(h.menu.items, hasLength(2),
          reason: 'a dropped refresh must not blank a menu being worked through');
    });
  });

  group('availability', () {
    test('the toggle flips OPTIMISTICALLY', () async {
      final h = harness();
      await h.menu.load();

      h.transport.gate = Completer<void>();
      final pending = h.menu.setAvailability('i1', false);

      // The UI has already updated, before the server has answered.
      expect(h.menu.items.first.isAvailable, isFalse);
      expect(h.menu.isPending('i1'), isTrue);

      h.transport.gate!.complete();
      h.transport.gate = null;
      expect(await pending, isTrue);
      expect(h.menu.isPending('i1'), isFalse);
    });

    test('IT REVERTS WHEN THE SERVER REFUSES', () async {
      final h = harness();
      await h.menu.load();
      expect(h.menu.items.first.isAvailable, isTrue);

      h.transport.failWith = const _Offline();
      expect(await h.menu.setAvailability('i1', false), isFalse);

      expect(h.menu.items.first.isAvailable, isTrue,
          reason: 'a switch stuck in the wrong position means the kitchen '
              'keeps getting orders it cannot cook');
      expect(h.menu.error, isNotNull);
    });

    test('a second tap while one is in flight is ignored', () async {
      final h = harness();
      await h.menu.load();

      h.transport.gate = Completer<void>();
      final first = h.menu.setAvailability('i1', false);
      final second = h.menu.setAvailability('i1', true);
      h.transport.gate!.complete();
      h.transport.gate = null;
      await Future.wait([first, second]);

      final patches =
          h.transport.calls.where((c) => c.startsWith('PATCH')).length;
      expect(patches, 1, reason: 'racing taps would leave an unknown state');
    });

    test('the boolean is sent as a boolean, not a string', () async {
      final h = harness();
      await h.menu.load();
      await h.menu.setAvailability('i1', false);

      final body = h.transport.bodies.last;
      expect(body, contains('"isAvailable":false'));
      expect(body, isNot(contains('"false"')),
          reason: 'a string "false" is truthy and would switch it ON');
    });

    test('an unknown item is a no-op', () async {
      final h = harness();
      await h.menu.load();
      expect(await h.menu.setAvailability('ghost', false), isFalse);
    });
  });

  group('adding a dish', () {
    test('a new dish reloads the menu so it gets a server id', () async {
      final h = harness();
      await h.menu.load();
      h.transport.calls.clear();

      expect(await h.menu.addItem(name: 'Waakye', pricePesewas: 2000), isTrue);

      expect(h.transport.calls, contains('POST /api/vendor/menu'));
      expect(h.transport.calls, contains('GET /api/vendor/menu'));
    });

    test('a rejected dish surfaces the reason', () async {
      final h = harness();
      await h.menu.load();
      h.transport.routes['POST /api/vendor/menu'] =
          (422, {'title': 'Validation Failed', 'detail': 'Price cannot be zero'});

      expect(await h.menu.addItem(name: 'Free lunch', pricePesewas: 0), isFalse);
      expect(h.menu.error, contains('Price cannot be zero'));
    });
  });

  group('cedis parsing', () {
    test('vendors type cedis; the app sends pesewas', () {
      expect(parseCedis('35'), 3500);
      expect(parseCedis('35.00'), 3500);
      expect(parseCedis('35.50'), 3550);
      expect(parseCedis('0.05'), 5);
      expect(parseCedis(' 12.34 '), 1234);
    });

    test('rounding is kind to a hurried thumb', () {
      expect(parseCedis('35.999'), 3600,
          reason: 'truncating would silently undercharge by a pesewa');
      expect(parseCedis('35.994'), 3599);
    });

    test('nonsense is rejected rather than becoming zero', () {
      expect(parseCedis(''), isNull);
      expect(parseCedis('free'), isNull);
      expect(parseCedis('-5'), isNull);
      expect(parseCedis('35.00.00'), isNull);
    });
  });

  /* ---------------------------------------------------------------- */

  group('screen', () {
    Future<void> pump(WidgetTester t, Widget child) async {
      await t.binding.setSurfaceSize(const Size(360, 740));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(MaterialApp(home: child));
      await t.pump();
    }

    testWidgets('sold-out items are visibly marked', (t) async {
      final h = harness();
      await h.menu.load();
      await pump(t, MenuScreen(controller: h.menu));

      expect(find.text('Jollof Rice'), findsOneWidget);
      expect(find.text('Grilled Tilapia'), findsOneWidget);
      expect(find.text('SOLD OUT'), findsOneWidget);
      expect(find.byKey(const Key('sold-out-banner')), findsOneWidget);
    });

    testWidgets('tapping the switch marks a dish sold out', (t) async {
      final h = harness();
      await h.menu.load();
      await pump(t, MenuScreen(controller: h.menu));

      await t.tap(find.byKey(const Key('toggle-i1')));
      await t.pumpAndSettle();

      expect(h.menu.items.first.isAvailable, isFalse);
      expect(find.text('2 items hidden from customers'), findsOneWidget);
    });

    testWidgets('a failure is shown, and the switch goes back', (t) async {
      final h = harness();
      await h.menu.load();
      await pump(t, MenuScreen(controller: h.menu));

      h.transport.failWith = const _Offline();
      await t.tap(find.byKey(const Key('toggle-i1')));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('menu-action-error')), findsOneWidget);
      final sw = t.widget<Switch>(find.byKey(const Key('toggle-i1')));
      expect(sw.value, isTrue, reason: 'the dish is still on sale');
    });

    testWidgets('an empty menu invites a first dish', (t) async {
      final h = harness();
      h.transport.routes['GET /api/vendor/menu'] = (200, {'items': []});
      await h.menu.load();
      await pump(t, MenuScreen(controller: h.menu));

      expect(find.byKey(const Key('menu-empty')), findsOneWidget);
    });

    testWidgets('lays out on a 360dp phone without overflow', (t) async {
      final h = harness();
      h.transport.routes['GET /api/vendor/menu'] = (200, {
        'items': [
          {'id': 'i1', 'name': 'Grilled Tilapia with Banku and Pepper Sauce',
            'basePricePesewas': '12500', 'isAvailable': false},
        ],
      });
      await h.menu.load();
      await pump(t, MenuScreen(controller: h.menu));

      final e = t.takeException();
      expect(e == null || !e.toString().contains('overflowed'), isTrue);
    });

    testWidgets('the add sheet validates before calling the server', (t) async {
      final h = harness();
      await h.menu.load();
      h.transport.calls.clear();

      await pump(t, Scaffold(body: AddItemSheet(controller: h.menu)));

      await t.tap(find.byKey(const Key('save-item')));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('add-item-error')), findsOneWidget);
      expect(h.transport.calls, isEmpty);
    });

    testWidgets('a valid dish is posted in pesewas', (t) async {
      final h = harness();
      await h.menu.load();
      h.transport.bodies.clear();

      await pump(t, Scaffold(body: AddItemSheet(controller: h.menu)));
      await t.enterText(find.byKey(const Key('new-item-name')), 'Waakye');
      await t.enterText(find.byKey(const Key('new-item-price')), '20.50');
      await t.tap(find.byKey(const Key('save-item')));
      await t.pumpAndSettle();

      expect(h.transport.bodies.first, contains('"basePricePesewas":"2050"'),
          reason: 'the vendor types cedis; the wire carries pesewas');
    });
  });
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
