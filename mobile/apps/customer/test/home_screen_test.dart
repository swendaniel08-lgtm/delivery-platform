import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_ui/besonc_ui.dart';
import 'package:besonc_customer/screens/home_screen.dart';

/// Minimal BFF payload; overridden per test.
Map<String, dynamic> homeJson({
  Map<String, dynamic>? deliveringTo = const {
    'label': 'Home', 'lat': 5.556, 'lng': -0.182,
    'areaName': 'Osu', 'landmark': 'behind the MTN mast',
  },
  Map<String, dynamic>? activeOrder,
  List<Map<String, dynamic>>? popular,
  List<Map<String, dynamic>>? topRated,
}) =>
    {
      'deliveringTo': deliveringTo,
      'services': const [
        {'key': 'food', 'label': 'Food', 'enabled': true},
        {'key': 'groceries', 'label': 'Groceries', 'enabled': false},
        {'key': 'market', 'label': 'Market', 'enabled': false},
        {'key': 'shop', 'label': 'Shop', 'enabled': false},
        {'key': 'pharmacy', 'label': 'Pharmacy', 'enabled': false},
        {'key': 'laundry', 'label': 'Laundry', 'enabled': false},
        {'key': 'parcel', 'label': 'Parcel', 'enabled': true},
        {'key': 'errand', 'label': 'Errand', 'enabled': false},
      ],
      'activeOrder': activeOrder,
      'popularNearYou': popular ?? const [],
      'topRated': topRated ?? const [],
    };

Map<String, dynamic> store(String id, {
  bool isOpen = true, double rating = 4.6, String? opensAt,
}) =>
    {
      'id': id, 'name': "Auntie Adwoa's Kitchen", 'rating': rating,
      'prepEstimate': '25-35 min', 'deliveryFee': 'GHS 5.00',
      'isOpen': isOpen, if (opensAt != null) 'opensAt': opensAt,
    };

Future<void> pumpHome(
  WidgetTester tester, {
  Size surface = const Size(420, 1400),
  LoadState state = LoadState.ready,
  Map<String, dynamic>? json,
  void Function(String)? onOpenService,
  void Function(String)? onOpenStore,
  VoidCallback? onRetry,
  VoidCallback? onOpenActiveOrder,
}) async {
  // A real phone shows far more than the 800x600 default test viewport;
  // without this, lazily-built slivers below the fold never render.
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));

  await tester.pumpWidget(MaterialApp(
    theme: besoncTheme(),
    home: HomeScreen(
      state: state,
      data: state == LoadState.ready ? HomeData.fromJson(json ?? homeJson()) : null,
      onOpenService: onOpenService,
      onOpenStore: onOpenStore,
      onRetry: onRetry,
      onOpenActiveOrder: onOpenActiveOrder,
    ),
  ));
  await tester.pump();
}

void main() {
  group('loading and failure', () {
    testWidgets('shows a skeleton while loading, not a bare spinner',
        (tester) async {
      await pumpHome(tester, state: LoadState.loading);
      expect(find.byKey(const Key('home-skeleton')), findsOneWidget);
    });

    testWidgets('a failure explains itself and offers a retry', (tester) async {
      var retried = false;
      await pumpHome(tester,
          state: LoadState.failed, onRetry: () => retried = true);

      expect(find.byKey(const Key('home-error')), findsOneWidget);
      expect(find.text('Cannot reach Besonc'), findsOneWidget);

      await tester.tap(find.text('Try again'));
      expect(retried, isTrue);
    });
  });

  group('address bar', () {
    testWidgets('shows the landmark, because that is what riders use',
        (tester) async {
      await pumpHome(tester);
      expect(find.text('Home — behind the MTN mast'), findsOneWidget);
    });

    testWidgets('a new customer is prompted to set an address', (tester) async {
      await pumpHome(tester, json: homeJson(deliveringTo: null));
      expect(find.text('Set your delivery address'), findsOneWidget);
      expect(find.text('Tap to choose'), findsOneWidget);
    });
  });

  group('service grid', () {
    testWidgets('all 8 services are visible even when disabled',
        (tester) async {
      await pumpHome(tester);
      for (final s in ['food', 'groceries', 'market', 'shop',
                       'pharmacy', 'laundry', 'parcel', 'errand']) {
        expect(find.byKey(Key('service-$s')), findsOneWidget,
            reason: '$s tile should be rendered');
      }
    });

    testWidgets('disabled services are marked "Soon" and are not tappable',
        (tester) async {
      final opened = <String>[];
      await pumpHome(tester, onOpenService: opened.add);

      // 6 of 8 are disabled at launch scope
      expect(find.text('Soon'), findsNWidgets(6));

      await tester.tap(find.byKey(const Key('service-pharmacy')));
      expect(opened, isEmpty, reason: 'a disabled tile must not navigate');
    });

    testWidgets('enabled services navigate', (tester) async {
      final opened = <String>[];
      await pumpHome(tester, onOpenService: opened.add);
      await tester.tap(find.byKey(const Key('service-food')));
      expect(opened, ['food']);
    });
  });

  group('active order banner', () {
    testWidgets('is absent when there is no active order', (tester) async {
      await pumpHome(tester);
      expect(find.byKey(const Key('active-order-banner')), findsNothing);
    });

    testWidgets('shows human-readable progress, never a raw state',
        (tester) async {
      await pumpHome(tester, json: homeJson(activeOrder: {
        'id': 'o1', 'humanRef': '#1234', 'state': 'preparing',
        'service': 'food', 'totalPesewas': '8150',
        'storeName': "Auntie Adwoa's",
      }));

      expect(find.byKey(const Key('active-order-banner')), findsOneWidget);
      expect(find.text('#1234'), findsOneWidget);
      expect(find.textContaining('preparing'), findsOneWidget);
      expect(find.textContaining('_'), findsNothing,
          reason: 'raw state names must never reach the UI');
    });

    testWidgets('shows a Live badge and the ETA once in transit',
        (tester) async {
      await pumpHome(tester, json: homeJson(activeOrder: {
        'id': 'o1', 'humanRef': '#1234', 'state': 'in_transit',
        'service': 'food', 'totalPesewas': '8150', 'etaMinutes': 8,
      }));
      expect(find.text('Live'), findsOneWidget);
      expect(find.textContaining('8 min'), findsOneWidget);
    });

    testWidgets('tapping opens tracking', (tester) async {
      var opened = false;
      await pumpHome(tester,
          onOpenActiveOrder: () => opened = true,
          json: homeJson(activeOrder: {
            'id': 'o1', 'humanRef': '#1234', 'state': 'arrived',
            'service': 'food', 'totalPesewas': '8150', 'riderName': 'Kwame',
          }));
      await tester.tap(find.byKey(const Key('active-order-banner')));
      expect(opened, isTrue);
    });
  });

  group('vendor carousels', () {
    testWidgets('render store cards with rating, prep time and fee',
        (tester) async {
      await pumpHome(tester, json: homeJson(popular: [store('s1')]));
      expect(find.byKey(const Key('carousel-popular')), findsOneWidget);
      expect(find.text("Auntie Adwoa's Kitchen"), findsOneWidget);
      expect(find.text('4.6'), findsOneWidget);
      expect(find.text('25-35 min'), findsOneWidget);
      expect(find.text('GHS 5.00 delivery'), findsOneWidget);
    });

    testWidgets('a closed vendor shows its opening time and cannot be tapped',
        (tester) async {
      final opened = <String>[];
      await pumpHome(tester,
          onOpenStore: opened.add,
          json: homeJson(popular: [
            store('closed', isOpen: false, opensAt: '08:00'),
          ]));

      expect(find.text('Opens 08:00'), findsOneWidget);
      await tester.tap(find.byKey(const Key('store-closed')));
      expect(opened, isEmpty,
          reason: 'tapping a closed vendor should not open it');
    });

    testWidgets('an open vendor navigates', (tester) async {
      final opened = <String>[];
      await pumpHome(tester,
          onOpenStore: opened.add, json: homeJson(popular: [store('s1')]));
      await tester.tap(find.byKey(const Key('store-s1')));
      expect(opened, ['s1']);
    });
  });

  group('independent degradation', () {
    testWidgets(
        'the catalogue failing still leaves the active order and services usable',
        (tester) async {
      await pumpHome(tester, json: homeJson(
        activeOrder: {
          'id': 'o1', 'humanRef': '#1234', 'state': 'in_transit',
          'service': 'food', 'totalPesewas': '8150', 'etaMinutes': 5,
        },
        popular: [], topRated: [],
      ));

      // the reason the customer opened the app still works
      expect(find.byKey(const Key('active-order-banner')), findsOneWidget);
      expect(find.byKey(const Key('service-grid')), findsOneWidget);
      // and the missing vendors are explained rather than silently blank
      expect(find.byKey(const Key('no-vendors')), findsOneWidget);
    });

    testWidgets('no notice is shown when vendors did load', (tester) async {
      await pumpHome(tester, json: homeJson(popular: [store('s1')]));
      expect(find.byKey(const Key('no-vendors')), findsNothing);
    });
  });

  group('accessibility', () {
    testWidgets('primary tap targets meet the 48px minimum', (tester) async {
      await pumpHome(tester);

      final addressBar = tester.getSize(find.byKey(const Key('address-bar')));
      expect(addressBar.height, greaterThanOrEqualTo(kMinTap));

      final search = tester.getSize(find.byKey(const Key('search-bar')));
      expect(search.height, greaterThanOrEqualTo(kMinTap));
    });
  });
}
