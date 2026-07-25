import 'package:test/test.dart';
import 'package:besonc_models/besonc_models.dart';

void main() {
  group('Pesewas', () {
    test('formats identically to the backend formatCedis', () {
      expect(const Pesewas(8150).display, 'GHS 81.50');
      expect(const Pesewas(5).display, 'GHS 0.05');
      expect(const Pesewas(1240000).display, 'GHS 12,400.00');
      expect(const Pesewas(100000000).display, 'GHS 1,000,000.00');
    });

    test('sign goes with the number, not before the currency', () {
      // "-GHS 2.05" reads as a negative currency; refunds must read correctly
      expect(const Pesewas(-205).display, 'GHS -2.05');
    });

    test('parses the wire string and round-trips', () {
      expect(Pesewas.parse('8150').value, 8150);
      expect(Pesewas.parse('8150').wire, '8150');
      expect(Pesewas.tryParse(null), isNull);
    });

    test('arithmetic stays exact — no float drift', () {
      var total = const Pesewas(0);
      for (var i = 0; i < 100000; i++) {
        total = total + const Pesewas(1);
      }
      expect(total.value, 100000);
      expect(total.display, 'GHS 1,000.00');
    });

    test('the classic 0.1 + 0.2 trap cannot occur', () {
      expect((const Pesewas(10) + const Pesewas(20)).display, 'GHS 0.30');
    });

    test('handles amounts beyond 2^53 — where JSON numbers would corrupt', () {
      final big = Pesewas.parse('9007199254740993');
      expect(big.wire, '9007199254740993');
    });

    test('multiplies by quantity', () {
      expect((const Pesewas(3500) * 3).display, 'GHS 105.00');
    });
  });

  group('OrderState', () {
    test('maps every backend wire value', () {
      expect(OrderState.fromWire('picked_up'), OrderState.pickedUp);
      expect(OrderState.fromWire('ready_for_pickup'), OrderState.readyForPickup);
      expect(OrderState.fromWire('delivered_to_customer'),
          OrderState.deliveredToCustomer);
    });

    test('an UNKNOWN server state degrades instead of crashing', () {
      // a newer backend must never break an older app
      expect(OrderState.fromWire('some_future_state'), OrderState.unknown);
      expect(OrderState.unknown.customerLabel, 'In progress');
    });

    test('terminal states are recognised', () {
      expect(OrderState.delivered.isTerminal, isTrue);
      expect(OrderState.cancelled.isTerminal, isTrue);
      expect(OrderState.preparing.isTerminal, isFalse);
    });

    test('tracking only applies once a rider is carrying the order', () {
      expect(OrderState.preparing.isTrackable, isFalse);
      expect(OrderState.pickedUp.isTrackable, isTrue);
      expect(OrderState.arrived.isTrackable, isTrue);
      expect(OrderState.delivered.isTrackable, isFalse);
    });

    test('never leaks raw state names to customers', () {
      for (final s in OrderState.values) {
        expect(s.customerLabel, isNot(contains('_')),
            reason: '${s.name} exposes a raw state name');
        expect(s.customerLabel, isNotEmpty);
      }
    });
  });

  group('ActiveOrder', () {
    ActiveOrder make(String state, {int? eta}) => ActiveOrder.fromJson({
          'id': 'o1', 'humanRef': '#1234', 'state': state, 'service': 'food',
          'totalPesewas': '8150', 'storeName': "Auntie Adwoa's",
          'riderName': 'Kwame', if (eta != null) 'etaMinutes': eta,
        });

    test('parses from the BFF payload', () {
      final o = make('preparing');
      expect(o.humanRef, '#1234');
      expect(o.total.display, 'GHS 81.50');
      expect(o.state, OrderState.preparing);
    });

    test('the home banner reads naturally at each stage', () {
      expect(make('preparing').bannerText, contains('preparing'));
      expect(make('in_transit', eta: 8).bannerText, contains('8 min'));
      expect(make('arrived').bannerText, contains('Kwame'));
    });

    test('an in-transit order with no ETA still reads sensibly', () {
      expect(make('in_transit').bannerText, 'Your order is on the way');
    });
  });

  group('Address', () {
    test('prefers the landmark, because that is what riders use', () {
      final a = Address.fromJson({
        'id': 'a1', 'label': 'Home', 'lat': 5.556, 'lng': -0.182,
        'areaName': 'Osu', 'landmark': 'behind the MTN mast',
      });
      expect(a.shortDisplay, 'Home — behind the MTN mast');
    });

    test('falls back to the area when there is no landmark', () {
      final a = Address.fromJson({
        'id': 'a1', 'label': 'Home', 'lat': 5.556, 'lng': -0.182,
        'areaName': 'Osu',
      });
      expect(a.shortDisplay, 'Osu');
    });
  });

  group('AddonGroup validation mirrors the server', () {
    final protein = AddonGroup.fromJson({
      'id': 'g1', 'name': 'Protein', 'required': true,
      'minSelections': 1, 'maxSelections': 3,
      'options': [
        {'id': 'a1', 'name': 'Chicken', 'pricePesewas': '1500'},
        {'id': 'a2', 'name': 'Fish', 'pricePesewas': '1200'},
        {'id': 'a3', 'name': 'Beef', 'pricePesewas': '1000'},
        {'id': 'a4', 'name': 'Egg', 'pricePesewas': '500'},
      ],
    });

    test('a required group must be satisfied', () {
      expect(protein.validate({}), 'Choose a Protein');
      expect(protein.validate({'a1'}), isNull);
    });

    test('the maximum is enforced client-side too', () {
      expect(protein.validate({'a1', 'a2', 'a3', 'a4'}), 'Choose at most 3');
    });
  });

  group('CartLine', () {
    test('quantity multiplies base AND addons', () {
      final line = CartLine(
        itemId: 'i1', name: 'Jollof', unitPrice: const Pesewas(3500),
        quantity: 3, addonTotal: const Pesewas(1500),
      );
      expect(line.lineTotal.display, 'GHS 150.00');
    });

    test('serialises ids and quantity only — never prices', () {
      final json = CartLine(
        itemId: 'i1', name: 'Jollof', unitPrice: const Pesewas(3500),
        addonIds: {'a1'},
      ).toJson();
      expect(json.containsKey('unitPrice'), isFalse,
          reason: 'the client must never send prices');
      expect(json['itemId'], 'i1');
      expect(json['addonOptionIds'], ['a1']);
    });
  });
}
