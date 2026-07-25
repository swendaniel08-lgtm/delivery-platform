import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/state/cart_controller.dart';

CartItemDraft jollof({
  int quantity = 1,
  Set<String>? addons,
  Pesewas addonTotal = const Pesewas(0),
  String storeId = 's1',
  String storeName = "Auntie Adwoa's",
  String? note,
}) =>
    CartItemDraft(
      itemId: 'i1', name: 'Jollof Rice', basePrice: const Pesewas(3500),
      storeId: storeId, storeName: storeName, quantity: quantity,
      addonIds: addons, addonTotal: addonTotal, note: note,
    );

AddonGroup protein({bool required = true, int max = 3}) => AddonGroup.fromJson({
      'id': 'g1', 'name': 'Protein', 'required': required,
      'minSelections': required ? 1 : 0, 'maxSelections': max,
      'options': [
        {'id': 'a1', 'name': 'Chicken', 'pricePesewas': '1500'},
        {'id': 'a2', 'name': 'Fish', 'pricePesewas': '1200'},
        {'id': 'a3', 'name': 'Beef', 'pricePesewas': '1000', 'available': false},
      ],
    });

AddonGroup extras() => AddonGroup.fromJson({
      'id': 'g2', 'name': 'Extras', 'required': false,
      'minSelections': 0, 'maxSelections': 2,
      'options': [
        {'id': 'e1', 'name': 'Plantain', 'pricePesewas': '500'},
        {'id': 'e2', 'name': 'Shito', 'pricePesewas': '0'},
      ],
    });

void main() {
  group('one vendor per cart (PDF §13)', () {
    test('items from the same vendor accumulate', () {
      final cart = CartController();
      cart.add(jollof());
      cart.add(jollof(addons: {'a1'}, addonTotal: const Pesewas(1500)));
      expect(cart.lines.length, 2);
      expect(cart.storeName, "Auntie Adwoa's");
    });

    test('a different vendor throws with both names for the prompt', () {
      final cart = CartController();
      cart.add(jollof());
      expect(
        () => cart.add(jollof(storeId: 's2', storeName: 'KFC Osu')),
        throwsA(isA<DifferentVendorException>()
            .having((e) => e.message, 'message', contains("Auntie Adwoa's"))
            .having((e) => e.message, 'message', contains('KFC Osu'))),
      );
    });

    test('the rejected item does NOT silently enter the cart', () {
      final cart = CartController();
      cart.add(jollof());
      try {
        cart.add(jollof(storeId: 's2', storeName: 'KFC'));
      } catch (_) {}
      expect(cart.lines.length, 1);
      expect(cart.storeId, 's1');
    });

    test('starting a new cart replaces everything', () {
      final cart = CartController();
      cart.add(jollof());
      cart.replaceWith(jollof(storeId: 's2', storeName: 'KFC Osu'));
      expect(cart.lines.length, 1);
      expect(cart.storeName, 'KFC Osu');
    });
  });

  group('line merging', () {
    test('identical configurations merge instead of duplicating', () {
      final cart = CartController();
      cart.add(jollof(addons: {'a1'}, addonTotal: const Pesewas(1500)));
      cart.add(jollof(addons: {'a1'}, addonTotal: const Pesewas(1500)));
      expect(cart.lines.length, 1);
      expect(cart.lines.first.quantity, 2);
    });

    test('the same dish with different addons stays two lines', () {
      final cart = CartController();
      cart.add(jollof(addons: {'a1'}, addonTotal: const Pesewas(1500)));
      cart.add(jollof(addons: {'a2'}, addonTotal: const Pesewas(1200)));
      expect(cart.lines.length, 2,
          reason: 'chicken and fish jollof are different orders');
    });

    test('addon order does not affect merging', () {
      final cart = CartController();
      cart.add(jollof(addons: {'a1', 'e1'}));
      cart.add(jollof(addons: {'e1', 'a1'}));
      expect(cart.lines.length, 1);
    });

    test('a different note keeps lines separate', () {
      final cart = CartController();
      cart.add(jollof(note: 'no pepper'));
      cart.add(jollof());
      expect(cart.lines.length, 2);
    });
  });

  group('quantities', () {
    test('increment and decrement adjust the line', () {
      final cart = CartController();
      cart.add(jollof());
      final sig = cart.lines.first.signature;
      cart.increment(sig);
      expect(cart.lines.first.quantity, 2);
      cart.decrement(sig);
      expect(cart.lines.first.quantity, 1);
    });

    test('decrementing to zero removes the line', () {
      final cart = CartController();
      cart.add(jollof());
      cart.decrement(cart.lines.first.signature);
      expect(cart.isEmpty, isTrue);
    });

    test('quantity is capped at the server limit', () {
      final cart = CartController();
      cart.add(jollof());
      cart.setQuantity(cart.lines.first.signature, 500);
      expect(cart.lines.first.quantity, kMaxLineQuantity);
    });

    test('merging cannot exceed the cap either', () {
      final cart = CartController();
      cart.add(jollof(quantity: 90));
      cart.add(jollof(quantity: 90));
      expect(cart.lines.first.quantity, kMaxLineQuantity);
    });
  });

  group('totals', () {
    test('reproduces the PDF §20 cart: jollof + chicken and 2 sobolo', () {
      final cart = CartController();
      cart.add(jollof(addons: {'a1'}, addonTotal: const Pesewas(1500)));
      cart.add(CartItemDraft(
        itemId: 'i2', name: 'Sobolo', basePrice: const Pesewas(1000),
        storeId: 's1', storeName: "Auntie Adwoa's", quantity: 2,
      ));
      expect(cart.subtotal.display, 'GHS 70.00');
      expect(cart.itemCount, 3);
    });

    test('quantity multiplies base AND addons', () {
      final cart = CartController();
      cart.add(jollof(quantity: 3, addons: {'a1'}, addonTotal: const Pesewas(1500)));
      expect(cart.subtotal.display, 'GHS 150.00');
    });

    test('an empty cart is GHS 0.00, not an error', () {
      expect(CartController().subtotal.display, 'GHS 0.00');
    });
  });

  group('checkout payload', () {
    test('sends ids and quantities only — never prices', () {
      final cart = CartController();
      cart.add(jollof(addons: {'a1'}, addonTotal: const Pesewas(1500)));
      final payload = cart.toCheckoutPayload();
      final encoded = payload.toString();

      expect(payload['storeId'], 's1');
      expect(encoded.contains('3500'), isFalse,
          reason: 'the client must never send a price');
      expect(encoded.contains('price'), isFalse);
      expect((payload['lines'] as List).first['itemId'], 'i1');
    });
  });

  group('notifies listeners', () {
    test('every mutation triggers a rebuild', () {
      final cart = CartController();
      var notifications = 0;
      cart.addListener(() => notifications++);

      cart.add(jollof());
      cart.increment(cart.lines.first.signature);
      cart.clear();
      expect(notifications, 3);
    });
  });

  group('ItemConfiguration', () {
    ItemConfiguration config({bool proteinRequired = true, int max = 3}) =>
        ItemConfiguration(
          itemId: 'i1', name: 'Jollof Rice', basePrice: const Pesewas(3500),
          storeId: 's1', storeName: "Auntie Adwoa's",
          addonGroups: [protein(required: proteinRequired, max: max), extras()],
        );

    test('a required group blocks Add until satisfied', () {
      final c = config();
      expect(c.canAdd, isFalse);
      expect(c.validationError, 'Choose a Protein');
      c.toggle(protein(), 'a1');
      expect(c.canAdd, isTrue);
    });

    test('single-choice groups REPLACE rather than ignore the tap', () {
      final c = config(max: 1);
      final g = protein(max: 1);
      c.toggle(g, 'a1');
      c.toggle(g, 'a2');
      expect(c.selected, {'a2'},
          reason: 'a radio that ignores taps feels broken');
    });

    test('multi-select stops at the maximum', () {
      final c = config();
      final g = extras();
      c.toggle(g, 'e1');
      c.toggle(g, 'e2');
      c.toggle(protein(), 'a1'); // satisfy required
      // extras max is 2, both already chosen
      expect(c.selected.containsAll({'e1', 'e2'}), isTrue);
      expect(c.selected.length, 3);
    });

    test('tapping a selected option deselects it', () {
      final c = config();
      final g = protein();
      c.toggle(g, 'a1');
      c.toggle(g, 'a1');
      expect(c.selected, isEmpty);
    });

    test('an option that went out of stock blocks Add', () {
      final c = config();
      c.toggle(protein(), 'a3'); // Beef, unavailable
      expect(c.canAdd, isFalse);
      expect(c.validationError, contains('out of stock'));
    });

    test('live total reflects addons and quantity', () {
      final c = config();
      c.toggle(protein(), 'a1'); // +15.00
      expect(c.lineTotal.display, 'GHS 50.00');
      c.setQuantity(3);
      expect(c.lineTotal.display, 'GHS 150.00');
    });

    test('quantity cannot go below 1', () {
      final c = config()..setQuantity(0);
      expect(c.quantity, 1);
    });

    test('a blank note is normalised away', () {
      final c = config()..setNote('   ');
      expect(c.note, isNull);
      c.setNote('  no pepper  ');
      expect(c.note, 'no pepper');
    });

    test('produces a draft carrying the chosen options', () {
      final c = config();
      c.toggle(protein(), 'a1');
      c.setQuantity(2);
      c.setNote('extra hot');

      final draft = c.toDraft();
      expect(draft.quantity, 2);
      expect(draft.addonIds, {'a1'});
      expect(draft.addonTotal.display, 'GHS 15.00');
      expect(draft.note, 'extra hot');
      expect(draft.lineTotal.display, 'GHS 100.00');
    });
  });
}
