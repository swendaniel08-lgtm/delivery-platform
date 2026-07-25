import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/state/tracking_controller.dart';

const osu = LatLng(5.5560, -0.1821);

class Clock {
  DateTime now = DateTime.utc(2026, 7, 25, 12, 0, 0);
  void advance(Duration d) => now = now.add(d);
  DateTime call() => now;
}

({TrackingController c, Clock clock}) make({
  OrderState state = OrderState.inTransit,
}) {
  final clock = Clock();
  final c = TrackingController(
    orderId: 'o1', initialState: state, clock: clock.call,
  );
  return (c: c, clock: clock);
}

void main() {
  group('connection honesty', () {
    test('starts as connecting, not live', () {
      final h = make();
      expect(h.c.connection, ConnectionState.connecting);
      expect(h.c.connectionLabel, 'Connecting…');
    });

    test('a fresh position reports Live', () {
      final h = make();
      h.c.onConnected();
      h.c.onPosition(osu, etaSeconds: 300);
      expect(h.c.connectionLabel, 'Live');
    });

    test('a stale position says how old it is, never "Live"', () {
      final h = make();
      h.c.onConnected();
      h.c.onPosition(osu, etaSeconds: 300);
      h.clock.advance(const Duration(seconds: 50));
      expect(h.c.positionIsStale, isTrue);
      expect(h.c.connectionLabel, contains('Last seen'));
      expect(h.c.connectionLabel, isNot('Live'));
    });

    test('a very stale position admits we have lost the rider', () {
      final h = make();
      h.c.onConnected();
      h.c.onPosition(osu, etaSeconds: 300);
      h.clock.advance(const Duration(minutes: 4));
      expect(h.c.positionIsVeryStale, isTrue);
      expect(h.c.connectionLabel, 'Reconnecting to your rider…');
    });

    test('a dropped socket is degraded, not offline — the map still helps', () {
      final h = make();
      h.c.onConnected();
      h.c.onPosition(osu);
      h.c.onDisconnected();
      expect(h.c.connection, ConnectionState.degraded);
      expect(h.c.rider, isNotNull, reason: 'keep the last known position');
    });

    test('a new position after a drop restores Live', () {
      final h = make();
      h.c.onDisconnected();
      h.c.onPosition(osu, etaSeconds: 120);
      expect(h.c.connection, ConnectionState.live);
    });
  });

  group('ETA behaviour', () {
    test('counts down between server updates', () {
      final h = make();
      h.c.onPosition(osu, etaSeconds: 300);
      expect(h.c.etaSeconds, 300);
      h.clock.advance(const Duration(seconds: 30));
      expect(h.c.etaSeconds, 270);
    });

    test('never goes negative', () {
      final h = make();
      h.c.onPosition(osu, etaSeconds: 10);
      h.clock.advance(const Duration(minutes: 2));
      expect(h.c.etaSeconds, 0);
      expect(h.c.etaLabel, 'Arriving now');
    });

    test('stops guessing once the fix is very stale', () {
      final h = make();
      h.c.onPosition(osu, etaSeconds: 600);
      h.clock.advance(const Duration(minutes: 4));
      expect(h.c.etaSeconds, isNull,
          reason: 'an ETA from a 4-minute-old position is fiction');
      expect(h.c.etaLabel, isNull);
    });

    test('is coarse on purpose — a range invites fewer complaints', () {
      final h = make();
      h.c.onPosition(osu, etaSeconds: 40);
      expect(h.c.etaLabel, 'Less than a minute');

      h.c.onPosition(osu, etaSeconds: 180);
      expect(h.c.etaLabel, 'About 3 minutes');

      h.c.onPosition(osu, etaSeconds: 13 * 60);
      expect(h.c.etaLabel, 'About 15 minutes', reason: 'rounded to 5');
    });

    test('is absent when the server has not sent one', () {
      final h = make();
      h.c.onPosition(osu);
      expect(h.c.etaLabel, isNull);
    });
  });

  group('map visibility', () {
    test('no map before the rider has the order', () {
      final h = make(state: OrderState.preparing);
      h.c.onPosition(osu);
      expect(h.c.showMap, isFalse,
          reason: 'a rider heading to the vendor is not "your order moving"');
    });

    test('map appears once in transit', () {
      final h = make(state: OrderState.pickedUp);
      h.c.onPosition(osu);
      expect(h.c.showMap, isTrue);
    });

    test('map disappears the moment the order finishes', () {
      final h = make(state: OrderState.arrived);
      h.c.onPosition(osu);
      expect(h.c.showMap, isTrue);
      h.c.onStateChanged(OrderState.delivered);
      expect(h.c.showMap, isFalse);
      expect(h.c.rider, isNull);
    });
  });

  group('rider contact — consented calling (issue #3 v1)', () {
    test('the number is available during an active delivery', () {
      final h = make();
      h.c.setRider(name: 'Kwame', phone: '+233551234987', vehicle: 'motorbike');
      expect(h.c.riderPhone, '+233551234987');
      expect(h.c.canChat, isTrue);
    });

    test('the number is withheld once the order is terminal', () {
      final h = make();
      h.c.setRider(name: 'Kwame', phone: '+233551234987');
      h.c.onStateChanged(OrderState.delivered);
      expect(h.c.riderPhone, isNull,
          reason: 'a leaked number cannot be un-leaked');
      expect(h.c.canChat, isFalse);
    });

    test('unread message count never goes negative', () {
      final h = make();
      h.c.setUnreadMessages(-5);
      expect(h.c.unreadMessages, 0);
    });
  });

  group('progress indicator', () {
    test('maps states to the right step', () {
      expect(make(state: OrderState.placed).c.progressStep, 0);
      expect(make(state: OrderState.preparing).c.progressStep, 1);
      expect(make(state: OrderState.riderAssigned).c.progressStep, 2);
      expect(make(state: OrderState.inTransit).c.progressStep, 3);
      expect(make(state: OrderState.arrived).c.progressStep, 4);
      expect(make(state: OrderState.delivered).c.progressStep, 5);
    });

    test('a cancelled order has no step on the happy path', () {
      expect(make(state: OrderState.cancelled).c.progressStep, -1);
    });

    test('there is a label for every step', () {
      expect(TrackingController.progressLabels.length, 6);
    });
  });

  group('cancellation rules (PDF §8)', () {
    test('allowed before the vendor starts cooking', () {
      expect(make(state: OrderState.placed).c.canCancel, isTrue);
      expect(make(state: OrderState.vendorAccepted).c.canCancel, isTrue);
    });

    test('allowed during preparation but WARNS about the 50% charge', () {
      final h = make(state: OrderState.preparing);
      expect(h.c.canCancel, isTrue);
      expect(h.c.cancelWarning, contains('50%'));
    });

    test('refused once the food is on its way', () {
      for (final s in [
        OrderState.readyForPickup, OrderState.pickedUp,
        OrderState.inTransit, OrderState.arrived,
      ]) {
        expect(make(state: s).c.canCancel, isFalse, reason: s.name);
      }
    });

    test('no warning when cancelling is free', () {
      expect(make(state: OrderState.placed).c.cancelWarning, isNull);
    });
  });

  group('terminal states', () {
    test('the label shows the outcome, not a connection status', () {
      final h = make(state: OrderState.inTransit);
      h.c.onStateChanged(OrderState.delivered);
      expect(h.c.connectionLabel, 'Delivered');
    });

    test('a cancelled order reads correctly', () {
      final h = make();
      h.c.onStateChanged(OrderState.cancelled);
      expect(h.c.connectionLabel, 'Cancelled');
    });
  });

  group('notifications', () {
    test('every update rebuilds the UI', () {
      final h = make();
      var n = 0;
      h.c.addListener(() => n++);
      h.c.onConnected();
      h.c.onPosition(osu, etaSeconds: 100);
      h.c.setRider(name: 'Kwame');
      h.c.onStateChanged(OrderState.arrived);
      expect(n, 4);
    });
  });
}
