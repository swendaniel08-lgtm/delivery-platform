import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';
import 'package:besonc_customer/screens/vendor_screen.dart';
import 'package:besonc_customer/state/cart_controller.dart';

StoreCard storeCard({bool isOpen = true, String? opensAt}) =>
    StoreCard.fromJson({
      'id': 's1', 'name': "Auntie Adwoa's Kitchen", 'rating': 4.6,
      'prepEstimate': '25-35 min', 'deliveryFee': 'GHS 5.00',
      'isOpen': isOpen, if (opensAt != null) 'opensAt': opensAt,
    });

MenuItem jollof({bool available = true, bool withAddons = true}) =>
    MenuItem.fromJson({
      'id': 'i1', 'name': 'Jollof Rice', 'basePricePesewas': '3500',
      'available': available, 'description': 'Smoky party jollof',
      'addonGroups': withAddons
          ? [
              {
                'id': 'g1', 'name': 'Protein', 'required': true,
                'minSelections': 1, 'maxSelections': 1,
                'options': [
                  {'id': 'a1', 'name': 'Chicken', 'pricePesewas': '1500'},
                  {'id': 'a2', 'name': 'Fish', 'pricePesewas': '1200'},
                  {'id': 'a3', 'name': 'Beef', 'pricePesewas': '1000',
                   'available': false},
                ],
              },
            ]
          : <Map<String, dynamic>>[],
    });

Future<void> pumpVendor(
  WidgetTester tester, {
  StoreCard? store,
  List<MenuItem>? items,
  CartController? cart,
  void Function(MenuItem)? onConfigureItem,
  VoidCallback? onViewCart,
}) async {
  await tester.binding.setSurfaceSize(const Size(420, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    theme: besoncTheme(),
    home: VendorScreen(
      store: store ?? storeCard(),
      categories: [
        MenuCategory(name: 'Rice Dishes', items: items ?? [jollof()]),
      ],
      cart: cart ?? CartController(),
      onConfigureItem: onConfigureItem,
      onViewCart: onViewCart,
    ),
  ));
  await tester.pump();
}

Future<void> pumpSheet(
  WidgetTester tester, {
  MenuItem? item,
  void Function(CartItemDraft)? onAdd,
}) async {
  await tester.binding.setSurfaceSize(const Size(420, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    theme: besoncTheme(),
    home: Scaffold(
      body: ItemSheet(
        item: item ?? jollof(),
        storeId: 's1',
        storeName: "Auntie Adwoa's",
        onAdd: onAdd,
      ),
    ),
  ));
  await tester.pump();
}

void main() {
  group('vendor screen', () {
    testWidgets('shows the menu with prices', (tester) async {
      await pumpVendor(tester);
      expect(find.text('Jollof Rice'), findsOneWidget);
      expect(find.text('GHS 35.00'), findsOneWidget);
      expect(find.text('Rice Dishes'), findsOneWidget);
    });

    testWidgets('a closed vendor is announced and items are not tappable',
        (tester) async {
      final tapped = <String>[];
      await pumpVendor(tester,
          store: storeCard(isOpen: false, opensAt: '08:00'),
          onConfigureItem: (i) => tapped.add(i.id));

      expect(find.byKey(const Key('vendor-closed')), findsOneWidget);
      expect(find.textContaining('opens at 08:00'), findsOneWidget);

      await tester.tap(find.byKey(const Key('menu-item-i1')));
      expect(tapped, isEmpty);
    });

    testWidgets('an out-of-stock item is marked and not tappable',
        (tester) async {
      final tapped = <String>[];
      await pumpVendor(tester,
          items: [jollof(available: false)],
          onConfigureItem: (i) => tapped.add(i.id));

      expect(find.text('Out of stock'), findsOneWidget);
      await tester.tap(find.byKey(const Key('menu-item-i1')));
      expect(tapped, isEmpty);
    });

    testWidgets('tapping an available item opens configuration',
        (tester) async {
      final tapped = <String>[];
      await pumpVendor(tester, onConfigureItem: (i) => tapped.add(i.id));
      await tester.tap(find.byKey(const Key('menu-item-i1')));
      expect(tapped, ['i1']);
    });

    testWidgets('the cart bar is hidden when empty and shows the total when not',
        (tester) async {
      await pumpVendor(tester);
      expect(find.byKey(const Key('view-cart')), findsNothing);

      final cart = CartController()
        ..add(CartItemDraft(
          itemId: 'i1', name: 'Jollof', basePrice: const Pesewas(3500),
          storeId: 's1', storeName: "Auntie Adwoa's", quantity: 2,
        ));
      await pumpVendor(tester, cart: cart);

      expect(find.byKey(const Key('view-cart')), findsOneWidget);
      expect(find.textContaining('2 items'), findsOneWidget);
      expect(find.textContaining('GHS 70.00'), findsOneWidget);
    });
  });

  group('item sheet', () {
    testWidgets('a required group blocks Add and SAYS WHY', (tester) async {
      await pumpSheet(tester);

      expect(find.byKey(const Key('item-validation')), findsOneWidget);
      expect(find.text('Choose a Protein'), findsOneWidget);

      final button = tester.widget<FilledButton>(
        find.descendant(
          of: find.byKey(const Key('add-to-cart')),
          matching: find.byType(FilledButton),
        ),
      );
      expect(button.onPressed, isNull, reason: 'must be disabled');
    });

    testWidgets('choosing a required option enables Add', (tester) async {
      CartItemDraft? added;
      await pumpSheet(tester, onAdd: (d) => added = d);

      await tester.tap(find.byKey(const Key('addon-a1')));
      await tester.pump();

      expect(find.byKey(const Key('item-validation')), findsNothing);
      await tester.tap(find.byKey(const Key('add-to-cart')));
      expect(added, isNotNull);
      expect(added!.addonIds, {'a1'});
    });

    testWidgets('the running total updates live as options are chosen',
        (tester) async {
      await pumpSheet(tester);
      expect(find.textContaining('GHS 35.00'), findsOneWidget);

      await tester.tap(find.byKey(const Key('addon-a1'))); // +15.00
      await tester.pump();
      expect(find.textContaining('GHS 50.00'), findsOneWidget);
    });

    testWidgets('single-choice options replace rather than accumulate',
        (tester) async {
      CartItemDraft? added;
      await pumpSheet(tester, onAdd: (d) => added = d);

      await tester.tap(find.byKey(const Key('addon-a1')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('addon-a2')));
      await tester.pump();

      await tester.tap(find.byKey(const Key('add-to-cart')));
      expect(added!.addonIds, {'a2'});
      expect(added!.addonTotal.display, 'GHS 12.00');
    });

    testWidgets('an out-of-stock option cannot be selected', (tester) async {
      await pumpSheet(tester);
      await tester.tap(find.byKey(const Key('addon-a3')));
      await tester.pump();

      // still blocked by the required rule, i.e. nothing was selected
      expect(find.text('Choose a Protein'), findsOneWidget);
    });

    testWidgets('quantity controls adjust the total', (tester) async {
      await pumpSheet(tester);
      await tester.tap(find.byKey(const Key('addon-a1')));
      await tester.pump();

      expect(find.text('1'), findsOneWidget);
      await tester.tap(find.byKey(const Key('qty-plus')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('qty-plus')));
      await tester.pump();

      expect(find.text('3'), findsOneWidget);
      expect(find.textContaining('GHS 150.00'), findsOneWidget);
    });

    testWidgets('quantity cannot drop below one', (tester) async {
      await pumpSheet(tester);
      final minus = tester.widget<IconButton>(find.byKey(const Key('qty-minus')));
      expect(minus.onPressed, isNull);
    });

    testWidgets('an item with no addons can be added immediately',
        (tester) async {
      CartItemDraft? added;
      await pumpSheet(tester,
          item: jollof(withAddons: false), onAdd: (d) => added = d);

      expect(find.byKey(const Key('item-validation')), findsNothing);
      await tester.tap(find.byKey(const Key('add-to-cart')));
      expect(added, isNotNull);
      expect(added!.lineTotal.display, 'GHS 35.00');
    });

    testWidgets('required and optional groups are labelled', (tester) async {
      await pumpSheet(tester);
      expect(find.text('Required'), findsOneWidget);
      expect(find.text('Choose 1'), findsOneWidget);
    });

    testWidgets('option rows meet the minimum tap target', (tester) async {
      await pumpSheet(tester);
      final size = tester.getSize(find.byKey(const Key('addon-a1')));
      expect(size.height, greaterThanOrEqualTo(kMinTap));
    });
  });
}
