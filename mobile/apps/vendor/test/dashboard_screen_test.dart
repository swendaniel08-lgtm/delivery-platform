import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_ui/besonc_ui.dart';
import 'package:besonc_vendor/screens/dashboard_screen.dart';
import 'package:besonc_vendor/state/order_queue_controller.dart';

class Clock {
  DateTime now = DateTime.utc(2026, 7, 25, 12, 0, 0);
  DateTime call() => now;
}

VendorOrder order({
  String id = 'o1',
  String ref = '#1234',
  String state = 'placed',
  int placedSecondsAgo = 0,
  bool isCod = false,
  String? riderName,
  String? note,
}) =>
    VendorOrder.fromJson({
      'id': id, 'humanRef': ref, 'state': state,
      'itemTotalPesewas': '7000', 'vendorAmountPesewas': '5950',
      'placedAt': DateTime.utc(2026, 7, 25, 12, 0, 0)
          .subtract(Duration(seconds: placedSecondsAgo))
          .toIso8601String(),
      'isCod': isCod,
      if (riderName != null) 'riderName': riderName,
      'lines': [
        {
          'name': 'Jollof Rice', 'quantity': 2,
          'addonNames': ['Chicken'], if (note != null) 'note': note,
        },
      ],
    });

Future<OrderQueueController> pump(
  WidgetTester tester, {
  List<VendorOrder>? orders,
  bool loading = false,
  String? error,
  bool isOpen = true,
  void Function(String, VendorAction)? onAct,
  void Function(bool)? onToggleOpen,
}) async {
  await tester.binding.setSurfaceSize(const Size(420, 1600));
  addTearDown(() => tester.binding.setSurfaceSize(null));

  final c = OrderQueueController(clock: Clock().call);
  if (error != null) {
    c.setError(error);
  } else if (!loading) {
    c.setOrders(orders ?? []);
  }
  c.setOpen(isOpen);

  await tester.pumpWidget(MaterialApp(
    theme: besoncTheme(),
    home: DashboardScreen(
      controller: c,
      storeName: "Auntie Adwoa's Kitchen",
      rating: 4.6,
      onAct: onAct,
      onToggleOpen: onToggleOpen,
    ),
  ));
  await tester.pump();
  return c;
}

void main() {
  group('loading and errors', () {
    testWidgets('shows a skeleton, not a bare spinner', (tester) async {
      await pump(tester, loading: true);
      expect(find.byKey(const Key('dashboard-skeleton')), findsOneWidget);
    });

    testWidgets('an outage explains itself', (tester) async {
      await pump(tester, error: 'No connection');
      expect(find.byKey(const Key('dashboard-error')), findsOneWidget);
      expect(find.text('No connection'), findsOneWidget);
    });
  });

  group('the countdown is impossible to miss', () {
    testWidgets('shows time remaining on a new order', (tester) async {
      await pump(tester, orders: [order(placedSecondsAgo: 40)]);
      expect(find.byKey(const Key('countdown-o1')), findsOneWidget);
      expect(find.text('2:20'), findsOneWidget);
    });

    testWidgets('an expired order says "Time up" and cannot be accepted',
        (tester) async {
      final acted = <String>[];
      await pump(tester,
          orders: [order(placedSecondsAgo: 400)],
          onAct: (id, _) => acted.add(id));

      expect(find.text('Time up'), findsOneWidget);
      expect(find.byKey(const Key('blocked-o1')), findsOneWidget);
      expect(find.byKey(const Key('accept-o1')), findsNothing,
          reason: 'the buttons are replaced by an explanation');
      expect(acted, isEmpty);
    });

    testWidgets('an expired card stays on screen', (tester) async {
      await pump(tester, orders: [order(placedSecondsAgo: 400)]);
      expect(find.byKey(const Key('order-o1')), findsOneWidget,
          reason: 'an order must not silently vanish');
    });
  });

  group('new orders', () {
    testWidgets('accept and reject both work', (tester) async {
      final acted = <(String, VendorAction)>[];
      await pump(tester,
          orders: [order()], onAct: (id, a) => acted.add((id, a)));

      await tester.tap(find.byKey(const Key('accept-o1')));
      expect(acted.last, ('o1', VendorAction.accept));

      await tester.tap(find.byKey(const Key('reject-o1')));
      expect(acted.last, ('o1', VendorAction.reject));
    });

    testWidgets('the vendor sees what they EARN, not the order total',
        (tester) async {
      await pump(tester, orders: [order()]);
      expect(find.text('GHS 59.50'), findsWidgets);
      expect(find.text('GHS 70.00'), findsNothing,
          reason: 'showing gross makes payouts feel like deductions');
    });

    testWidgets('cash and prescription orders are flagged', (tester) async {
      await pump(tester, orders: [order(isCod: true)]);
      expect(find.text('CASH'), findsOneWidget);
    });

    testWidgets('a customer note is highlighted for the kitchen',
        (tester) async {
      await pump(tester, orders: [order(note: 'no pepper')]);
      expect(find.textContaining('no pepper'), findsOneWidget);
    });

    testWidgets('lines read as one glanceable string', (tester) async {
      await pump(tester, orders: [order()]);
      expect(find.text('2x Jollof Rice (Chicken)'), findsWidgets);
    });

    testWidgets('the most urgent order is listed first', (tester) async {
      await pump(tester, orders: [
        order(id: 'fresh', ref: '#1', placedSecondsAgo: 10),
        order(id: 'urgent', ref: '#2', placedSecondsAgo: 165),
      ]);
      final urgentY = tester.getTopLeft(find.byKey(const Key('order-urgent'))).dy;
      final freshY = tester.getTopLeft(find.byKey(const Key('order-fresh'))).dy;
      expect(urgentY, lessThan(freshY));
    });
  });

  group('in progress', () {
    testWidgets('shows the single next action', (tester) async {
      final acted = <(String, VendorAction)>[];
      await pump(tester,
          orders: [order(state: 'preparing')],
          onAct: (id, a) => acted.add((id, a)));

      expect(find.text('Ready for pickup'), findsOneWidget);
      await tester.tap(find.byKey(const Key('advance-o1')));
      expect(acted.last, ('o1', VendorAction.markReady));
    });

    testWidgets('waiting for a rider is informational, not a button',
        (tester) async {
      await pump(tester,
          orders: [order(state: 'ready_for_pickup', riderName: 'Kwame')]);
      expect(find.byKey(const Key('advance-o1')), findsNothing);
      expect(find.textContaining('Kwame is on the way'), findsOneWidget);
    });
  });

  group('open/closed switch', () {
    testWidgets('closing is blocked while new orders are unanswered',
        (tester) async {
      await pump(tester, orders: [order()]);
      expect(find.byKey(const Key('close-blocked')), findsOneWidget);

      final sw = tester.widget<Switch>(find.byKey(const Key('open-toggle')));
      expect(sw.onChanged, isNull,
          reason: 'closing must not strand an unanswered order');
    });

    testWidgets('closing is allowed once everything new is handled',
        (tester) async {
      final toggled = <bool>[];
      await pump(tester,
          orders: [order(state: 'preparing')],
          onToggleOpen: toggled.add);

      expect(find.byKey(const Key('close-blocked')), findsNothing);
      await tester.tap(find.byKey(const Key('open-toggle')));
      expect(toggled, [false]);
    });

    testWidgets('a closed shop can always reopen', (tester) async {
      final toggled = <bool>[];
      await pump(tester,
          isOpen: false, orders: [order()], onToggleOpen: toggled.add);
      await tester.tap(find.byKey(const Key('open-toggle')));
      expect(toggled, [true]);
    });
  });

  group('empty state', () {
    testWidgets('a quiet kitchen reads as caught up, not broken',
        (tester) async {
      await pump(tester, orders: []);
      expect(find.byKey(const Key('all-clear')), findsOneWidget);
      expect(find.text('All caught up'), findsOneWidget);
    });

    testWidgets('completed orders still show today\'s figures',
        (tester) async {
      await pump(tester, orders: [order(state: 'delivered')]);
      expect(find.byKey(const Key('stat-earnings')), findsOneWidget);
      expect(find.textContaining('Completed today: 1'), findsOneWidget);
    });
  });

  group('double-tap protection', () {
    testWidgets('a pending order disables its buttons', (tester) async {
      final c = await pump(tester, orders: [order()]);
      expect(find.byKey(const Key('accept-o1')), findsOneWidget);

      c.markPending('o1');
      await tester.pump();

      expect(find.byKey(const Key('blocked-o1')), findsOneWidget);
      expect(find.text('Sending…'), findsOneWidget);
      expect(find.byKey(const Key('accept-o1')), findsNothing);
    });
  });
}
