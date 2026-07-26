import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';
import 'package:besonc_rider/screens/rider_home_screen.dart';
import 'package:besonc_rider/state/rider_controller.dart';

class Clock {
  DateTime now = DateTime.utc(2026, 7, 25, 12, 0, 0);
  DateTime call() => now;
}

ActiveLeg leg({String state = 'assigned', bool isCod = false}) =>
    ActiveLeg.fromJson({
      'legId': 'leg1', 'orderId': 'o1', 'humanRef': '#1234',
      'state': state, 'service': 'food', 'feePesewas': '800',
      'isCod': isCod, if (isCod) 'codAmountPesewas': '8150',
      'pickup': {'lat': 5.556, 'lng': -0.182, 'label': "Auntie Adwoa's"},
      'dropoff': {
        'lat': 5.58, 'lng': -0.175, 'label': 'Osu',
        'landmark': 'blue gate behind the MTN mast',
      },
    });

DispatchOffer offer({bool isCod = false, int expiresIn = 30}) =>
    DispatchOffer.fromJson({
      'legId': 'leg1', 'orderId': 'o1', 'service': 'food',
      'pickupLabel': "Auntie Adwoa's", 'dropoffArea': 'Cantonments',
      'earningsPesewas': '800', 'distanceMetres': 1400, 'isCod': isCod,
      'expiresAt': DateTime.utc(2026, 7, 25, 12, 0, 0)
          .add(Duration(seconds: expiresIn)).toIso8601String(),
    });

Future<RiderController> pump(
  WidgetTester tester, {
  ActiveLeg? activeLeg,
  DispatchOffer? activeOffer,
  int codPesewas = 0,
  Duration? codAge,
  bool approved = true,
  bool online = false,
  bool hasProof = false,
  bool cashConfirmed = false,
  void Function(String)? onAdvance,
  void Function(bool)? onToggleOnline,
  VoidCallback? onAcceptOffer,
  VoidCallback? onChat,
  Size surface = const Size(420, 1600),
}) async {
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));

  final clock = Clock();
  final c = RiderController(clock: clock.call)..setApproved(approved);
  if (codPesewas > 0) {
    c.setCod(
      obligation: Pesewas(codPesewas),
      oldestUnremitted: clock.now.subtract(codAge ?? Duration.zero),
    );
  }
  c.setEarnings(today: const Pesewas(12000), deliveries: 8);
  if (online) c.setOnline(true);
  if (activeLeg != null) c.setLeg(activeLeg);
  if (activeOffer != null) c.setOffer(activeOffer);

  await tester.pumpWidget(MaterialApp(
    theme: besoncTheme(),
    home: RiderHomeScreen(
      controller: c,
      riderName: 'Kwame Mensah',
      hasProof: hasProof,
      cashConfirmed: cashConfirmed,
      onAdvance: onAdvance,
      onToggleOnline: onToggleOnline,
      onAcceptOffer: onAcceptOffer,
      onChat: onChat,
    ),
  ));
  await tester.pump();
  return c;
}

void main() {
  group('going online', () {
    testWidgets('an approved rider can go online', (tester) async {
      final toggled = <bool>[];
      await pump(tester, onToggleOnline: toggled.add);
      await tester.tap(find.byKey(const Key('online-toggle')));
      expect(toggled, [true]);
    });

    testWidgets('an unapproved rider is blocked with a reason',
        (tester) async {
      await pump(tester, approved: false);
      expect(find.byKey(const Key('online-blocked')), findsOneWidget);
      expect(find.textContaining('under review'), findsOneWidget);
    });

    testWidgets('a suspended rider is blocked and told to remit',
        (tester) async {
      await pump(tester,
          codPesewas: 10000, codAge: const Duration(hours: 50));
      expect(find.byKey(const Key('online-blocked')), findsOneWidget);
      expect(find.textContaining('Remit'), findsWidgets);
    });
  });

  group('the cash banner is unmissable', () {
    testWidgets('is hidden when nothing is owed', (tester) async {
      await pump(tester);
      expect(find.byKey(const Key('cod-banner')), findsNothing);
    });

    testWidgets('shows the amount owed as soon as there is any',
        (tester) async {
      await pump(tester, codPesewas: 8500);
      expect(find.byKey(const Key('cod-banner')), findsOneWidget);
      expect(find.text('GHS 85.00'), findsOneWidget);
      expect(find.byKey(const Key('remit-now')), findsOneWidget);
    });

    testWidgets('a warned rider sees the suspension deadline', (tester) async {
      await pump(tester,
          codPesewas: 10000, codAge: const Duration(hours: 25));
      expect(find.byKey(const Key('cod-message')), findsOneWidget);
      expect(find.textContaining('suspended in'), findsOneWidget);
    });
  });

  group('idle state', () {
    testWidgets('offline reads as offline, not broken', (tester) async {
      await pump(tester);
      expect(find.byKey(const Key('idle')), findsOneWidget);
      expect(find.text('You are offline'), findsOneWidget);
    });

    testWidgets('online but waiting explains what happens next',
        (tester) async {
      await pump(tester, online: true);
      expect(find.text('Looking for deliveries'), findsOneWidget);
    });
  });

  group('active job — one action at a time', () {
    testWidgets('heading to the vendor shows the pickup, no landmark',
        (tester) async {
      await pump(tester, activeLeg: leg(state: 'assigned'));
      expect(find.byKey(const Key('nav-target')), findsOneWidget);
      expect(find.text("Auntie Adwoa's"), findsOneWidget);
      expect(find.byKey(const Key('landmark')), findsNothing,
          reason: 'clutter while riding to the vendor');
      expect(find.text('Arrived at pickup'), findsOneWidget);
    });

    testWidgets('after pickup the landmark appears — it finds the address',
        (tester) async {
      await pump(tester, activeLeg: leg(state: 'picked_up'));
      expect(find.byKey(const Key('landmark')), findsOneWidget);
      expect(find.text('blue gate behind the MTN mast'), findsOneWidget);
    });

    testWidgets('advancing calls back with the state-machine event',
        (tester) async {
      final events = <String>[];
      await pump(tester,
          activeLeg: leg(state: 'assigned'), onAdvance: events.add);
      await tester.tap(find.byKey(const Key('advance')));
      expect(events, ['rider_arrive_pickup']);
    });

    testWidgets('there is exactly ONE primary action', (tester) async {
      await pump(tester, activeLeg: leg(state: 'picked_up'));
      expect(find.byKey(const Key('advance')), findsOneWidget);
      expect(find.text('Arrived at customer'), findsOneWidget);
    });

    testWidgets('the rider can MESSAGE the customer about the gate',
        (tester) async {
      // Ghanaian addresses are landmarks, so "which gate?" is the question
      // that actually completes the delivery. Without this the rider has to
      // phone, which costs both sides airtime and exposes both numbers.
      var opened = false;
      await pump(tester,
          activeLeg: leg(state: 'picked_up'), onChat: () => opened = true);

      await tester.tap(find.byKey(const Key('rider-chat')));
      expect(opened, isTrue);
    });

    testWidgets('Navigate and Message fit side by side on a 360dp phone',
        (tester) async {
      // The row was added at 420dp, which is wider than the phone most
      // Ghanaian riders carry. Two buttons in a Row is exactly the shape
      // that has overflowed here before.
      await pump(tester,
          activeLeg: leg(state: 'picked_up'),
          surface: const Size(360, 740));
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('rider-chat')), findsOneWidget);
      expect(find.byKey(const Key('navigate')), findsOneWidget);
    });
  });

  group('completing a delivery is guarded', () {
    testWidgets('proof is required before the button works', (tester) async {
      final events = <String>[];
      await pump(tester,
          activeLeg: leg(state: 'arrived'), onAdvance: events.add);

      expect(find.byKey(const Key('take-proof')), findsOneWidget);
      expect(find.byKey(const Key('advance-blocked')), findsOneWidget);
      expect(find.textContaining('photo'), findsWidgets);
      expect(find.byKey(const Key('advance')), findsNothing);
      expect(events, isEmpty);
    });

    testWidgets('with proof taken the delivery can complete', (tester) async {
      final events = <String>[];
      await pump(tester,
          activeLeg: leg(state: 'arrived'),
          hasProof: true, onAdvance: events.add);
      await tester.tap(find.byKey(const Key('advance')));
      expect(events, ['rider_deliver']);
    });

    testWidgets('a cash delivery shows the amount and needs confirmation',
        (tester) async {
      await pump(tester,
          activeLeg: leg(state: 'arrived', isCod: true), hasProof: true);

      expect(find.byKey(const Key('collect-amount')), findsOneWidget);
      expect(find.text('GHS 81.50'), findsWidgets);
      expect(find.byKey(const Key('confirm-cash')), findsOneWidget);
      expect(find.byKey(const Key('advance')), findsNothing,
          reason: 'cash must be confirmed before completing');
    });

    testWidgets('with proof AND cash confirmed the delivery completes',
        (tester) async {
      final events = <String>[];
      await pump(tester,
          activeLeg: leg(state: 'arrived', isCod: true),
          hasProof: true, cashConfirmed: true, onAdvance: events.add);
      await tester.tap(find.byKey(const Key('advance')));
      expect(events, ['rider_deliver']);
    });

    testWidgets('earlier steps show no proof controls', (tester) async {
      await pump(tester, activeLeg: leg(state: 'assigned'));
      expect(find.byKey(const Key('take-proof')), findsNothing);
      expect(find.byKey(const Key('confirm-cash')), findsNothing);
    });
  });

  group('offer takeover', () {
    testWidgets('an offer replaces the whole screen', (tester) async {
      await pump(tester, activeOffer: offer());
      expect(find.byKey(const Key('offer-countdown')), findsOneWidget);
      expect(find.byKey(const Key('offer-earnings')), findsOneWidget);
      // the normal home content is gone
      expect(find.byKey(const Key('online-toggle')), findsNothing);
    });

    testWidgets('shows earnings, pickup and only the drop-off AREA',
        (tester) async {
      await pump(tester, activeOffer: offer());
      expect(find.text('GHS 8.00'), findsOneWidget);
      expect(find.text("Auntie Adwoa's"), findsOneWidget);
      expect(find.text('Cantonments'), findsOneWidget);
      expect(find.textContaining('blue gate'), findsNothing,
          reason: 'the exact address is withheld until acceptance');
    });

    testWidgets('accepting calls back', (tester) async {
      var accepted = false;
      await pump(tester,
          activeOffer: offer(), onAcceptOffer: () => accepted = true);
      await tester.tap(find.byKey(const Key('accept-offer')));
      expect(accepted, isTrue);
    });

    testWidgets('a cash offer at the ceiling cannot be accepted',
        (tester) async {
      await pump(tester,
          activeOffer: offer(isCod: true), codPesewas: 35000);
      expect(find.byKey(const Key('offer-blocked')), findsOneWidget);
      expect(find.byKey(const Key('accept-offer')), findsNothing);
    });

    testWidgets('a cash offer is labelled so the rider knows before accepting',
        (tester) async {
      await pump(tester, activeOffer: offer(isCod: true));
      expect(find.text('COLLECT CASH'), findsOneWidget);
    });

    testWidgets('an expired offer falls back to the normal home screen',
        (tester) async {
      await pump(tester, activeOffer: offer(expiresIn: -5));
      expect(find.byKey(const Key('offer-countdown')), findsNothing);
      expect(find.byKey(const Key('online-toggle')), findsOneWidget);
    });
  });
}
