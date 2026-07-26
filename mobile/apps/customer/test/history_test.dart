/// Order history.
///
/// Most people open this screen for one of three reasons: find a receipt,
/// reorder, or check whether they were charged twice. That third one sets the
/// bar for everything here.
///
/// Three states must NEVER render the same way:
///   • "you have no orders"
///   • "we could not reach the server"
///   • "still loading"
/// Collapsing them is how a customer concludes their orders have vanished and
/// phones support.
///
/// Widget tests run at 360x740 — the phone width most common in Ghana.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/state/history_controller.dart';
import 'package:besonc_customer/screens/history_screen.dart';

const phone = Size(360, 740);

/// A source we can page, fail and stall on demand.
class FakeSource implements HistorySource {
  FakeSource({this.total = 0, this.pageSize = 5});

  int total;
  int pageSize;
  bool fail = false;
  bool failAfterFirstPage = false;
  Completer<void>? hold;

  final List<String?> cursorsSeen = [];
  int calls = 0;

  @override
  Future<({List<HistoryOrder> orders, String? nextCursor})> fetch({
    String? cursor,
  }) async {
    calls++;
    cursorsSeen.add(cursor);
    if (hold != null) await hold!.future;
    if (fail) throw Exception('network');
    if (failAfterFirstPage && cursor != null) throw Exception('network');

    final start = cursor == null ? 0 : int.parse(cursor);
    final end = (start + pageSize).clamp(0, total);
    final orders = [
      for (var i = start; i < end; i++)
        HistoryOrder(
          id: 'ord-$i',
          humanRef: '#${1000 + i}',
          state: i == 0 ? OrderState.inTransit : OrderState.delivered,
          service: 'food',
          totalDisplay: 'GHS 81.50',
          placedAt: DateTime(2026, 7, 26, 12).subtract(Duration(hours: i)),
          storeName: "Auntie Adwoa's",
          itemCount: 3,
        ),
    ];
    return (orders: orders, nextCursor: end < total ? '$end' : null);
  }
}

HistoryOrder order({
  String id = 'o1',
  OrderState state = OrderState.delivered,
  bool isCod = false,
  String? storeName = "Auntie Adwoa's",
  DateTime? placedAt,
  int itemCount = 2,
}) =>
    HistoryOrder(
      id: id,
      humanRef: '#1234',
      state: state,
      service: 'food',
      totalDisplay: 'GHS 81.50',
      placedAt: placedAt ?? DateTime.now().subtract(const Duration(hours: 2)),
      storeName: storeName,
      isCod: isCod,
      itemCount: itemCount,
    );

Future<void> pump(WidgetTester tester, HistoryController c) async {
  await tester.binding.setSurfaceSize(phone);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(home: HistoryScreen(controller: c)));
  await tester.pump();
}

void main() {
  /* ---------------------------------------------------------------- */

  group('parsing', () {
    test('reads the wire shape bff-customer sends', () {
      final o = HistoryOrder.fromJson({
        'id': 'ord-1',
        'humanRef': '#1234',
        'state': 'delivered',
        'service': 'food',
        'totalDisplay': 'GHS 81.50',
        'placedAt': '2026-07-26T12:00:00.000Z',
        'storeName': "Auntie Adwoa's",
        'isCod': true,
        'itemCount': 3,
      });
      expect(o.state, OrderState.delivered);
      // Formatted by the server; the app must not re-derive money.
      expect(o.totalDisplay, 'GHS 81.50');
      expect(o.isCod, isTrue);
      expect(o.itemCount, 3);
    });

    test('a broken date does not take down the list', () {
      // One malformed row must not blank a customer's whole history.
      final o = HistoryOrder.fromJson({'id': 'x', 'placedAt': 'nonsense'});
      expect(o.placedAt.millisecondsSinceEpoch, 0);
    });

    test('an unknown state degrades rather than throwing', () {
      final o = HistoryOrder.fromJson({'id': 'x', 'state': 'invented_state'});
      expect(o.state, isNotNull);
    });

    test('an in-flight order is marked active', () {
      expect(order(state: OrderState.inTransit).isActive, isTrue);
      expect(order(state: OrderState.delivered).isActive, isFalse);
    });
  });

  /* ---------------------------------------------------------------- */

  group('the three states are distinct', () {
    test('empty means EMPTY, not "not loaded yet"', () async {
      final c = HistoryController(source: FakeSource(total: 0));
      // Before loading, we do not know — and must not claim — that it is empty.
      expect(c.isEmpty, isFalse);
      await c.refresh();
      expect(c.isEmpty, isTrue);
      expect(c.error, isNull);
    });

    test('a failure is NOT an empty list', () async {
      // The important one. "You have no orders" after a network failure is a
      // lie that makes someone phone support.
      final c = HistoryController(source: FakeSource(total: 5)..fail = true);
      await c.refresh();
      expect(c.orders, isEmpty);
      expect(c.error, isNotNull);
      expect(c.isEmpty, isFalse,
          reason: 'a failure must never look like "no orders"');
    });

    test('a failed REFRESH keeps what was already on screen', () async {
      final s = FakeSource(total: 3);
      final c = HistoryController(source: s);
      await c.refresh();
      expect(c.orders, hasLength(3));

      s.fail = true;
      await c.refresh();
      expect(c.orders, hasLength(3),
          reason: 'a failed refresh must not blank the page');
      expect(c.error, contains('last loaded'));
    });
  });

  /* ---------------------------------------------------------------- */

  group('paging', () {
    test('loads the first page and offers more', () async {
      final c = HistoryController(source: FakeSource(total: 12, pageSize: 5));
      await c.refresh();
      expect(c.orders, hasLength(5));
      expect(c.hasMore, isTrue);
    });

    test('appends rather than replacing', () async {
      final c = HistoryController(source: FakeSource(total: 12, pageSize: 5));
      await c.refresh();
      await c.loadMore();
      expect(c.orders, hasLength(10));
    });

    test('reaches the end and stops', () async {
      final c = HistoryController(source: FakeSource(total: 12, pageSize: 5));
      await c.refresh();
      await c.loadMore();
      await c.loadMore();
      expect(c.orders, hasLength(12));
      expect(c.hasMore, isFalse);

      // Further calls must be no-ops, not repeated requests.
      await c.loadMore();
      expect(c.orders, hasLength(12));
    });

    test('a double-fired scroll does not fetch the same page twice', () async {
      // A scroll listener fires repeatedly near the bottom. Without the
      // in-flight guard the same cursor is fetched twice and the page appears
      // duplicated — which on THIS screen reads as a double charge.
      final s = FakeSource(total: 20, pageSize: 5);
      s.hold = Completer<void>();
      final c = HistoryController(source: s);

      s.hold!.complete();
      s.hold = null;
      await c.refresh();

      s.hold = Completer<void>();
      final a = c.loadMore();
      final b = c.loadMore();
      s.hold!.complete();
      await Future.wait([a, b]);

      expect(c.orders, hasLength(10));
      expect(c.orders.map((o) => o.id).toSet(), hasLength(10));
    });

    test('a duplicate row from the server is dropped', () async {
      // Belt and braces on top of the keyset cursor. A repeated order on this
      // screen is the single most alarming thing it could show.
      final s = _RepeatingSource();
      final c = HistoryController(source: s);
      await c.refresh();
      await c.loadMore();
      expect(c.orders.map((o) => o.id).toSet().length, c.orders.length);
    });

    test('a failed PAGE keeps the pages already loaded', () async {
      final s = FakeSource(total: 20, pageSize: 5)..failAfterFirstPage = true;
      final c = HistoryController(source: s);
      await c.refresh();
      await c.loadMore();

      expect(c.orders, hasLength(5),
          reason: 'page 1 must survive page 2 failing');
      expect(c.pageError, isNotNull);
      expect(c.error, isNull,
          reason: 'a page failure is not a screen failure');
    });

    test('a failed page can be retried', () async {
      final s = FakeSource(total: 20, pageSize: 5)..failAfterFirstPage = true;
      final c = HistoryController(source: s);
      await c.refresh();
      await c.loadMore();
      expect(c.pageError, isNotNull);

      s.failAfterFirstPage = false;
      await c.loadMore();
      expect(c.orders, hasLength(10));
      expect(c.pageError, isNull);
    });

    test('the cursor is passed back, not a page number', () async {
      final s = FakeSource(total: 20, pageSize: 5);
      final c = HistoryController(source: s);
      await c.refresh();
      await c.loadMore();
      expect(s.cursorsSeen, [null, '5']);
    });
  });

  /* ---------------------------------------------------------------- */

  group('HistoryScreen', () {
    testWidgets('renders orders at 360dp with no overflow', (tester) async {
      final c = HistoryController(source: FakeSource(total: 3));
      await c.refresh();
      await pump(tester, c);
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('history-list')), findsOneWidget);
      expect(find.text('GHS 81.50'), findsWidgets);
    });

    testWidgets('a long store name does not overflow', (tester) async {
      final c = HistoryController(source: _OneOrderSource(order(
        storeName: 'Auntie Adwoa Special Jollof and Grilled Tilapia Kitchen, Osu',
      )));
      await c.refresh();
      await pump(tester, c);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the EMPTY state says there are no orders', (tester) async {
      final c = HistoryController(source: FakeSource(total: 0));
      await c.refresh();
      await pump(tester, c);
      expect(find.byKey(const Key('history-empty')), findsOneWidget);
      expect(find.byKey(const Key('history-error')), findsNothing);
    });

    testWidgets('the FAILED state offers a retry and does NOT claim empty',
        (tester) async {
      final c = HistoryController(source: FakeSource(total: 5)..fail = true);
      await c.refresh();
      await pump(tester, c);

      expect(find.byKey(const Key('history-error')), findsOneWidget);
      expect(find.byKey(const Key('history-retry')), findsOneWidget);
      // The distinction this whole screen turns on.
      expect(find.byKey(const Key('history-empty')), findsNothing);
      expect(find.textContaining("haven't placed"), findsNothing);
    });

    testWidgets('retry actually refetches', (tester) async {
      final s = FakeSource(total: 3)..fail = true;
      final c = HistoryController(source: s);
      await c.refresh();
      await pump(tester, c);

      s.fail = false;
      await tester.tap(find.byKey(const Key('history-retry')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('history-list')), findsOneWidget);
    });

    testWidgets('a stale refresh shows a banner ABOVE the old rows',
        (tester) async {
      final s = FakeSource(total: 3);
      final c = HistoryController(source: s);
      await c.refresh();
      s.fail = true;
      await c.refresh();
      await pump(tester, c);

      expect(find.byKey(const Key('history-stale')), findsOneWidget);
      expect(find.byKey(const Key('history-list')), findsOneWidget);
    });

    testWidgets('an in-flight order is marked trackable', (tester) async {
      final c = HistoryController(source: FakeSource(total: 2));
      await c.refresh();
      await pump(tester, c);
      // ord-0 is inTransit in the fake source.
      expect(find.text('Track'), findsOneWidget);
    });

    testWidgets('a cash order is labelled', (tester) async {
      final c = HistoryController(source: _OneOrderSource(order(isCod: true)));
      await c.refresh();
      await pump(tester, c);
      expect(find.text('Cash'), findsOneWidget);
    });

    testWidgets('the end of the list says so', (tester) async {
      final c = HistoryController(source: FakeSource(total: 2, pageSize: 5));
      await c.refresh();
      await pump(tester, c);
      expect(find.byKey(const Key('history-end')), findsOneWidget);
    });

    testWidgets('a page error offers a tap-to-retry footer', (tester) async {
      final c = HistoryController(
        source: FakeSource(total: 20, pageSize: 5)..failAfterFirstPage = true,
      );
      await c.refresh();
      await c.loadMore();
      await pump(tester, c);

      expect(find.byKey(const Key('history-page-error')), findsOneWidget);
      // The already-loaded rows are still there.
      expect(find.byKey(const Key('history-list')), findsOneWidget);
    });

    testWidgets('tapping an order calls back', (tester) async {
      final c = HistoryController(source: _OneOrderSource(order(id: 'o1')));
      await c.refresh();
      HistoryOrder? tapped;

      await tester.binding.setSurfaceSize(phone);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: HistoryScreen(controller: c, onOpenOrder: (o) => tapped = o),
      ));
      await tester.pump();

      await tester.tap(find.byKey(const Key('history-order-o1')));
      expect(tapped?.id, 'o1');
    });

    testWidgets('an order with a broken date still renders', (tester) async {
      final c = HistoryController(source: _OneOrderSource(order(
        placedAt: DateTime.fromMillisecondsSinceEpoch(0),
      )));
      await c.refresh();
      await pump(tester, c);
      expect(tester.takeException(), isNull);
      expect(find.textContaining('date unknown'), findsOneWidget);
    });
  });
}

/// Serves exactly one order.
class _OneOrderSource implements HistorySource {
  _OneOrderSource(this.only);
  final HistoryOrder only;

  @override
  Future<({List<HistoryOrder> orders, String? nextCursor})> fetch({
    String? cursor,
  }) async =>
      (orders: [only], nextCursor: null);
}

/// Deliberately returns an overlapping row on page 2.
class _RepeatingSource implements HistorySource {
  int calls = 0;

  @override
  Future<({List<HistoryOrder> orders, String? nextCursor})> fetch({
    String? cursor,
  }) async {
    calls++;
    if (cursor == null) {
      return (
        orders: [order(id: 'a'), order(id: 'b')],
        nextCursor: 'next',
      );
    }
    // 'b' repeats — exactly the OFFSET-pagination bug, simulated.
    return (orders: [order(id: 'b'), order(id: 'c')], nextCursor: null);
  }
}
