import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_vendor/state/order_queue_controller.dart';

class Clock {
  DateTime now = DateTime.utc(2026, 7, 25, 12, 0, 0);
  void advance(Duration d) => now = now.add(d);
  DateTime call() => now;
}

/// [placedSecondsAgo] is relative to the clock's start.
VendorOrder order({
  String id = 'o1',
  String ref = '#1234',
  String state = 'placed',
  int placedSecondsAgo = 0,
  bool isCod = false,
  String vendorAmount = '5950',
  String? riderName,
}) =>
    VendorOrder.fromJson({
      'id': id,
      'humanRef': ref,
      'state': state,
      'itemTotalPesewas': '7000',
      'vendorAmountPesewas': vendorAmount,
      'placedAt': DateTime.utc(2026, 7, 25, 12, 0, 0)
          .subtract(Duration(seconds: placedSecondsAgo))
          .toIso8601String(),
      'isCod': isCod,
      if (riderName != null) 'riderName': riderName,
      'lines': [
        {
          'name': 'Jollof Rice', 'quantity': 2,
          'addonNames': ['Chicken'], 'note': 'no pepper',
        },
      ],
    });

({OrderQueueController c, Clock clock}) make(List<VendorOrder> orders) {
  final clock = Clock();
  final c = OrderQueueController(clock: clock.call)..setOrders(orders);
  return (c: c, clock: clock);
}

void main() {
  group('the 3-minute accept deadline (PDF §11)', () {
    test('a fresh order shows the full window', () {
      final h = make([order()]);
      expect(h.c.secondsToRespond(h.c.newOrders.first), 180);
      expect(h.c.countdownLabel(h.c.newOrders.first), '3:00');
    });

    test('the deadline comes from placedAt, NOT from when the app saw it', () {
      // a push delayed 40s by the network: the vendor really has 2:20
      final h = make([order(placedSecondsAgo: 40)]);
      expect(h.c.secondsToRespond(h.c.newOrders.first), 140);
      expect(h.c.countdownLabel(h.c.newOrders.first), '2:20');
    });

    test('counts down with the clock', () {
      final h = make([order()]);
      h.clock.advance(const Duration(seconds: 45));
      expect(h.c.countdownLabel(h.c.newOrders.first), '2:15');
    });

    test('turns urgent under a minute', () {
      final h = make([order(placedSecondsAgo: 130)]);
      final o = h.c.newOrders.first;
      expect(h.c.secondsToRespond(o), 50);
      expect(h.c.isUrgent(o), isTrue);
    });

    test('is not urgent above a minute', () {
      final h = make([order(placedSecondsAgo: 60)]);
      expect(h.c.isUrgent(h.c.newOrders.first), isFalse);
    });

    test('never goes negative and says "Time up"', () {
      final h = make([order(placedSecondsAgo: 400)]);
      final o = h.c.newOrders.first;
      expect(h.c.secondsToRespond(o), 0);
      expect(h.c.hasExpired(o), isTrue);
      expect(h.c.countdownLabel(o), 'Time up');
    });

    test('an expired card stays VISIBLE but cannot be acted on', () {
      final h = make([order(placedSecondsAgo: 400)]);
      final o = h.c.newOrders.first;
      expect(h.c.newOrders.length, 1,
          reason: 'an order must not silently vanish from the screen');
      expect(h.c.canAct(o), isFalse);
      expect(h.c.blockedReason(o), contains('timed out'));
    });

    test('accepted orders have no countdown', () {
      final h = make([order(state: 'preparing')]);
      expect(h.c.secondsToRespond(h.c.inProgress.first), isNull);
    });
  });

  group('ordering by urgency', () {
    test('the order closest to auto-reject sits at the top', () {
      final h = make([
        order(id: 'fresh', placedSecondsAgo: 10),
        order(id: 'urgent', placedSecondsAgo: 160),
        order(id: 'middle', placedSecondsAgo: 90),
      ]);
      expect(h.c.newOrders.map((o) => o.id).toList(),
          ['urgent', 'middle', 'fresh']);
    });
  });

  group('grouping', () {
    test('splits new, in progress and completed', () {
      final h = make([
        order(id: 'n1', state: 'placed'),
        order(id: 'p1', state: 'preparing'),
        order(id: 'r1', state: 'ready_for_pickup'),
        order(id: 'd1', state: 'delivered'),
      ]);
      expect(h.c.newOrders.length, 1);
      expect(h.c.inProgress.length, 2);
      expect(h.c.completedCount, 1);
    });

    test('a prescription order awaiting review counts as new', () {
      final h = make([order(state: 'prescription_review')]);
      expect(h.c.newOrders.length, 1);
    });
  });

  group('the single next action', () {
    test('each state maps to exactly one button', () {
      expect(order(state: 'placed').primaryAction, VendorAction.accept);
      expect(order(state: 'vendor_accepted').primaryAction,
          VendorAction.markPreparing);
      expect(order(state: 'preparing').primaryAction, VendorAction.markReady);
      expect(order(state: 'ready_for_pickup').primaryAction,
          VendorAction.awaitingRider);
      expect(order(state: 'delivered').primaryAction, VendorAction.none);
    });

    test('waiting for a rider is informational, not actionable', () {
      final h = make([order(state: 'ready_for_pickup', riderName: 'Kwame')]);
      final o = h.c.inProgress.first;
      expect(h.c.canAct(o), isFalse);
      expect(h.c.blockedReason(o), 'Kwame is on the way');
    });

    test('with no rider yet the message says so', () {
      final h = make([order(state: 'ready_for_pickup')]);
      expect(h.c.blockedReason(h.c.inProgress.first), 'Waiting for a rider');
    });
  });

  group('double-tap protection', () {
    test('a pending order cannot be acted on again', () {
      final h = make([order()]);
      final o = h.c.newOrders.first;
      expect(h.c.canAct(o), isTrue);

      h.c.markPending(o.id);
      expect(h.c.canAct(o), isFalse,
          reason: 'a second tap must not accept twice');
      expect(h.c.blockedReason(o), 'Sending…');

      h.c.clearPending(o.id);
      expect(h.c.canAct(o), isTrue);
    });
  });

  group('alerting', () {
    test('alerts while a new order genuinely needs attention', () {
      final h = make([order()]);
      expect(h.c.shouldAlert, isTrue);
    });

    test('stops alerting once the vendor has responded', () {
      final h = make([order()]);
      h.c.markPending('o1');
      expect(h.c.shouldAlert, isFalse);
    });

    test('does not alert for an order that already timed out', () {
      final h = make([order(placedSecondsAgo: 400)]);
      expect(h.c.shouldAlert, isFalse,
          reason: 'nagging about a lost order is pure noise');
    });

    test('silent when there is nothing new', () {
      final h = make([order(state: 'preparing')]);
      expect(h.c.shouldAlert, isFalse);
    });
  });

  group("today's summary", () {
    test('earnings are NET of commission, not gross', () {
      final h = make([
        order(id: 'd1', state: 'delivered', vendorAmount: '5950'),
        order(id: 'd2', state: 'delivered', vendorAmount: '4000'),
        order(id: 'p1', state: 'preparing'),
      ]);
      expect(h.c.todayEarnings.display, 'GHS 99.50');
      expect(h.c.todayOrderCount, 2,
          reason: 'work in progress is not earned yet');
    });

    test('a quiet day reads GHS 0.00, not an error', () {
      final h = make([]);
      expect(h.c.todayEarnings.display, 'GHS 0.00');
    });
  });

  group('closing the shop', () {
    test('blocked while new orders are unanswered', () {
      final h = make([order(), order(id: 'o2', ref: '#1235')]);
      expect(h.c.canCloseShop, isFalse);
      expect(h.c.closeShopBlocker, contains('2 new orders'));
    });

    test('allowed once everything new is handled', () {
      final h = make([order(state: 'preparing')]);
      expect(h.c.canCloseShop, isTrue,
          reason: 'accepted work continues; only NEW orders block closing');
      expect(h.c.closeShopBlocker, isNull);
    });

    test('singular wording for one order', () {
      final h = make([order()]);
      expect(h.c.closeShopBlocker, contains('1 new order '));
    });
  });

  group('kitchen readability', () {
    test('a line reads as one glanceable string', () {
      final o = order();
      expect(o.lines.first.kitchenLine, '2x Jollof Rice (Chicken)');
    });

    test('item count sums quantities, not lines', () {
      expect(order().itemCount, 2);
    });
  });

  group('loading and errors', () {
    test('starts in a loading state', () {
      final c = OrderQueueController();
      expect(c.loading, isTrue);
    });

    test('an error clears loading and is surfaced', () {
      final c = OrderQueueController()..setError('No connection');
      expect(c.loading, isFalse);
      expect(c.error, 'No connection');
    });
  });

  group('notifications', () {
    test('every change rebuilds the UI', () {
      final c = OrderQueueController();
      var n = 0;
      c.addListener(() => n++);
      c.setOrders([order()]);
      c.markPending('o1');
      c.setOpen(false);
      expect(n, 3);
    });
  });
}
