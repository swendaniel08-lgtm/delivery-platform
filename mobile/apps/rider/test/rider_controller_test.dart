import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_rider/state/rider_controller.dart';

class Clock {
  DateTime now = DateTime.utc(2026, 7, 25, 12, 0, 0);
  void advance(Duration d) => now = now.add(d);
  DateTime call() => now;
}

ActiveLeg leg({String state = 'assigned', bool isCod = false}) =>
    ActiveLeg.fromJson({
      'legId': 'leg1', 'orderId': 'o1', 'humanRef': '#1234',
      'state': state, 'service': 'food', 'feePesewas': '800',
      'isCod': isCod, if (isCod) 'codAmountPesewas': '8150',
      'pickup': {'lat': 5.556, 'lng': -0.182, 'label': "Auntie Adwoa's"},
      'dropoff': {
        'lat': 5.580, 'lng': -0.175, 'label': 'Osu',
        'landmark': 'blue gate behind the MTN mast',
        'instructions': 'call when you arrive',
      },
    });

DispatchOffer offer({
  bool isCod = false, int expiresInSeconds = 30,
}) =>
    DispatchOffer.fromJson({
      'legId': 'leg1', 'orderId': 'o1', 'service': 'food',
      'pickupLabel': "Auntie Adwoa's", 'dropoffArea': 'Cantonments',
      'earningsPesewas': '800', 'distanceMetres': 1400,
      'isCod': isCod,
      'expiresAt': DateTime.utc(2026, 7, 25, 12, 0, 0)
          .add(Duration(seconds: expiresInSeconds))
          .toIso8601String(),
    });

({RiderController c, Clock clock}) make() {
  final clock = Clock();
  return (c: RiderController(clock: clock.call), clock: clock);
}

void main() {
  group('COD standing (PDF §7)', () {
    test('no cash held is clear', () {
      final h = make();
      expect(h.c.codStanding, CodStanding.clear);
      expect(h.c.canAcceptCod, isTrue);
      expect(h.c.canWork, isTrue);
    });

    test('a normal balance is just holding', () {
      final h = make();
      h.c.setCod(obligation: const Pesewas(12000), oldestUnremitted: h.clock.now);
      expect(h.c.codStanding, CodStanding.holding);
      expect(h.c.canAcceptCod, isTrue);
    });

    test('over GHS 300 blocks CASH orders but not all work', () {
      final h = make();
      h.c.setCod(obligation: const Pesewas(35000), oldestUnremitted: h.clock.now);
      expect(h.c.codStanding, CodStanding.blocked);
      expect(h.c.canAcceptCod, isFalse);
      expect(h.c.canWork, isTrue,
          reason: 'a rider may still take prepaid work');
    });

    test('24 hours outstanding warns with a deadline', () {
      final h = make();
      final old = h.clock.now.subtract(const Duration(hours: 25));
      h.c.setCod(obligation: const Pesewas(10000), oldestUnremitted: old);
      expect(h.c.codStanding, CodStanding.warned);
      expect(h.c.canWork, isTrue);
      expect(h.c.codMessage, contains('suspended in'));
    });

    test('48 hours outstanding blocks ALL work — debt stops earning', () {
      final h = make();
      final old = h.clock.now.subtract(const Duration(hours: 49));
      h.c.setCod(obligation: const Pesewas(10000), oldestUnremitted: old);
      expect(h.c.codStanding, CodStanding.suspended);
      expect(h.c.canWork, isFalse);
      expect(h.c.canGoOnline, isFalse);
      expect(h.c.codMessage, contains('GHS 100.00'));
    });

    test('clearing the balance restores everything', () {
      final h = make();
      final old = h.clock.now.subtract(const Duration(hours: 50));
      h.c.setCod(obligation: const Pesewas(10000), oldestUnremitted: old);
      expect(h.c.canWork, isFalse);
      h.c.setCod(obligation: const Pesewas(0));
      expect(h.c.codStanding, CodStanding.clear);
      expect(h.c.canGoOnline, isTrue);
    });
  });

  group('withdrawable balance', () {
    test('unremitted cash is subtracted from earnings', () {
      final h = make();
      h.c.setCod(obligation: const Pesewas(8000), oldestUnremitted: h.clock.now);
      expect(h.c.withdrawable(const Pesewas(10000)).display, 'GHS 20.00');
    });

    test('cash exceeding the wallet leaves nothing withdrawable', () {
      final h = make();
      h.c.setCod(obligation: const Pesewas(12000), oldestUnremitted: h.clock.now);
      expect(h.c.withdrawable(const Pesewas(5000)).display, 'GHS 0.00',
          reason: 'never show a negative withdrawable amount');
    });

    test('with no cash held the whole wallet is available', () {
      final h = make();
      expect(h.c.withdrawable(const Pesewas(34000)).display, 'GHS 340.00');
    });
  });

  group('going online', () {
    test('an unapproved rider cannot go online', () {
      final h = make();
      h.c.setApproved(false);
      expect(h.c.canGoOnline, isFalse);
      expect(h.c.onlineBlocker, contains('under review'));
      h.c.setOnline(true);
      expect(h.c.isOnline, isFalse, reason: 'the toggle must not stick');
    });

    test('a suspended rider cannot go online', () {
      final h = make();
      h.c.setCod(
          obligation: const Pesewas(10000),
          oldestUnremitted: h.clock.now.subtract(const Duration(hours: 50)));
      h.c.setOnline(true);
      expect(h.c.isOnline, isFalse);
    });

    test('a clear rider can toggle freely', () {
      final h = make();
      h.c.setOnline(true);
      expect(h.c.isOnline, isTrue);
      h.c.setOnline(false);
      expect(h.c.isOnline, isFalse);
    });

    test('cannot go online while already carrying a job', () {
      final h = make();
      h.c.setLeg(leg());
      expect(h.c.canGoOnline, isFalse);
    });
  });

  group('dispatch offers (PDF §4)', () {
    test('a 30-second window counts down', () {
      final h = make();
      h.c.setOffer(offer());
      expect(h.c.secondsToDecide(), 30);
      h.clock.advance(const Duration(seconds: 12));
      expect(h.c.secondsToDecide(), 18);
    });

    test('never goes negative and blocks acceptance once expired', () {
      final h = make();
      h.c.setOffer(offer());
      h.clock.advance(const Duration(seconds: 45));
      expect(h.c.secondsToDecide(), 0);
      expect(h.c.offerExpired, isTrue);
      expect(h.c.canAcceptOffer, isFalse);
      expect(h.c.offerBlocker, 'This offer expired');
    });

    test('only the drop-off AREA is shown before acceptance', () {
      final o = offer();
      expect(o.dropoffArea, 'Cantonments');
      // the exact address is simply not in the payload
      expect(o.toString(), isNot(contains('blue gate')));
    });

    test('a cash offer is refused when the rider is at the ceiling', () {
      final h = make();
      h.c.setCod(obligation: const Pesewas(35000), oldestUnremitted: h.clock.now);
      h.c.setOffer(offer(isCod: true));
      expect(h.c.canAcceptOffer, isFalse,
          reason: 'better to never show Accept than to fail after the tap');
      expect(h.c.offerBlocker, contains('remit'));
    });

    test('a prepaid offer is still acceptable at the cash ceiling', () {
      final h = make();
      h.c.setCod(obligation: const Pesewas(35000), oldestUnremitted: h.clock.now);
      h.c.setOffer(offer(isCod: false));
      expect(h.c.canAcceptOffer, isTrue);
    });

    test('distance reads naturally', () {
      expect(offer().distanceLabel, '1.4 km');
      expect(
        DispatchOffer.fromJson({
          'legId': 'l', 'orderId': 'o', 'earningsPesewas': '0',
          'distanceMetres': 350,
          'expiresAt': DateTime.utc(2026).toIso8601String(),
        }).distanceLabel,
        '350 m',
      );
    });
  });

  group('exactly one next action', () {
    test('each leg state maps to a single button', () {
      expect(leg(state: 'assigned').nextAction.event, 'rider_arrive_pickup');
      expect(leg(state: 'rider_at_pickup').nextAction.event, 'rider_pickup');
      expect(leg(state: 'picked_up').nextAction.event, 'rider_arrive');
      expect(leg(state: 'arrived').nextAction.event, 'rider_deliver');
      expect(leg(state: 'completed').nextAction.event, 'none');
    });

    test('an unknown server state degrades to Waiting, not a crash', () {
      expect(leg(state: 'some_future_state').nextAction.event, 'none');
    });
  });

  group('navigation target follows the leg', () {
    test('heads to the vendor before pickup', () {
      final l = leg(state: 'assigned');
      expect(l.headingToPickup, isTrue);
      expect(l.navigationLabel, "Auntie Adwoa's");
    });

    test('heads to the customer after pickup', () {
      final l = leg(state: 'picked_up');
      expect(l.headingToPickup, isFalse);
      expect(l.navigationLabel, 'Osu');
    });

    test('the landmark appears only when it is useful', () {
      expect(leg(state: 'assigned').visibleLandmark, isNull,
          reason: 'clutter while riding to the vendor');
      expect(leg(state: 'picked_up').visibleLandmark,
          'blue gate behind the MTN mast');
    });
  });

  group('completing a delivery is guarded', () {
    test('proof is always required', () {
      final h = make();
      h.c.setLeg(leg(state: 'arrived'));
      expect(h.c.canAdvance(hasProof: false), isFalse);
      expect(h.c.advanceBlocker(hasProof: false), contains('photo'));
      expect(h.c.canAdvance(hasProof: true), isTrue);
    });

    test('a cash delivery additionally needs the amount confirmed', () {
      final h = make();
      h.c.setLeg(leg(state: 'arrived', isCod: true));
      expect(h.c.canAdvance(hasProof: true), isFalse);
      expect(h.c.advanceBlocker(hasProof: true), contains('GHS 81.50'));
      expect(h.c.canAdvance(hasProof: true, cashConfirmed: true), isTrue);
    });

    test('earlier steps need neither', () {
      final h = make();
      h.c.setLeg(leg(state: 'assigned'));
      expect(h.c.canAdvance(), isTrue);
    });

    test('a submission in flight blocks a second tap', () {
      final h = make();
      h.c.setLeg(leg(state: 'assigned'));
      h.c.setSubmitting(true);
      expect(h.c.canAdvance(), isFalse);
      expect(h.c.advanceBlocker(), 'Sending…');
    });
  });

  group('notifications', () {
    test('every change rebuilds the UI', () {
      final h = make();
      var n = 0;
      h.c.addListener(() => n++);
      h.c.setOnline(true);
      h.c.setLeg(leg());
      h.c.setCod(obligation: const Pesewas(5000));
      h.c.setSubmitting(true);
      expect(n, 4);
    });
  });
}
