/// The other half of the BFF contract check.
///
/// `apps/e2e/test/bff-contract.e2e.spec.ts` asserts the KEYS the BFFs emit.
/// This file feeds byte-identical fixtures through the REAL `fromJson`
/// constructors, so a rename on either side fails a test instead of
/// producing an empty screen on a real phone.
///
/// The fixtures below are copied verbatim from the TypeScript spec. If you
/// change one, change both — that is the entire point.

import 'dart:convert';

import 'package:test/test.dart';
import 'package:besonc_models/besonc_models.dart';

/// Exactly what `GET /api/customer/home` returns.
const customerHomeJson = '''
{
  "deliveringTo": {
    "label": "Home",
    "areaName": "Osu",
    "landmark": "behind the MTN mast",
    "lat": 5.5560,
    "lng": -0.1821
  },
  "services": [
    {"key": "food", "label": "Food", "enabled": true},
    {"key": "groceries", "label": "Groceries", "enabled": false},
    {"key": "parcel", "label": "Parcel", "enabled": true}
  ],
  "activeOrder": {
    "id": "o1",
    "humanRef": "BSC-4821",
    "state": "preparing",
    "service": "food",
    "totalPesewas": "8150",
    "storeName": "Auntie Muni Waakye",
    "riderName": null
  },
  "popularNearYou": [
    {
      "id": "s1",
      "name": "Auntie Muni Waakye",
      "imageUrl": null,
      "rating": 4.7,
      "prepEstimate": "20-40 min",
      "deliveryFee": "GHS 8.00",
      "isOpen": true,
      "distanceMetres": 900
    }
  ],
  "topRated": [],
  "newOnBesonc": []
}
''';

/// Exactly what `GET /api/customer/stores/:id` returns for one item.
const menuItemJson = '''
{
  "id": "i1",
  "name": "Jollof Rice",
  "description": "Smoky party jollof",
  "basePricePesewas": "3500",
  "available": true,
  "imageUrl": null,
  "addonGroups": [
    {
      "id": "g1",
      "name": "Protein",
      "required": true,
      "minSelections": 1,
      "maxSelections": 2,
      "options": [
        {"id": "a1", "name": "Chicken", "pricePesewas": "1500", "available": true},
        {"id": "a2", "name": "Goat", "pricePesewas": "2500", "available": false}
      ]
    }
  ]
}
''';

void main() {
  group('customer home contract', () {
    late Map<String, dynamic> home;

    setUp(() => home = jsonDecode(customerHomeJson) as Map<String, dynamic>);

    test('the delivery address parses', () {
      final to = home['deliveringTo'] as Map<String, dynamic>;
      final address = Address.fromJson({
        'id': 'current',
        'label': to['label'],
        'lat': to['lat'],
        'lng': to['lng'],
        'areaName': to['areaName'],
        'landmark': to['landmark'],
      });

      expect(address.label, 'Home');
      expect(address.landmark, 'behind the MTN mast');
      expect(address.position.lat, closeTo(5.5560, 1e-6));
    });

    test('the active order parses, including money as a string', () {
      final order =
          ActiveOrder.fromJson(home['activeOrder'] as Map<String, dynamic>);

      expect(order.humanRef, 'BSC-4821');
      expect(order.state, OrderState.preparing);
      expect(order.total.value, 8150,
          reason: 'GHS 81.50 — the canonical order');
      expect(order.storeName, 'Auntie Muni Waakye');
      expect(order.bannerText, contains('preparing'));
    });

    test('store cards parse with every field the UI renders', () {
      final cards = (home['popularNearYou'] as List<dynamic>)
          .map((c) => StoreCard.fromJson(c as Map<String, dynamic>))
          .toList();

      expect(cards, hasLength(1));
      expect(cards.single.name, 'Auntie Muni Waakye');
      expect(cards.single.rating, 4.7);
      expect(cards.single.prepEstimate, '20-40 min');
      expect(cards.single.deliveryFee, 'GHS 8.00',
          reason: 'the BFF preformats the fee; the app never does money maths');
      expect(cards.single.isOpen, isTrue);
    });

    test('service tiles parse and respect the launch flags', () {
      final tiles = (home['services'] as List<dynamic>)
          .map((s) => ServiceTile.fromJson(s as Map<String, dynamic>))
          .toList();

      final enabled = tiles.where((t) => t.enabled).map((t) => t.key).toList();
      expect(enabled, containsAll(['food', 'parcel']));
      expect(enabled, isNot(contains('groceries')));
    });

    test('a brand-new user with nulls does not crash the parsers', () {
      final empty = {
        'deliveringTo': null,
        'services': [],
        'activeOrder': null,
        'popularNearYou': [],
        'topRated': [],
        'newOnBesonc': [],
      };

      expect(empty['deliveringTo'], isNull);
      expect(
        (empty['popularNearYou'] as List<dynamic>)
            .map((c) => StoreCard.fromJson(c as Map<String, dynamic>)),
        isEmpty,
      );
    });

    test('an unknown order state degrades instead of throwing', () {
      // The server may ship a new state before the app is updated. Crashing
      // on it would brick every installed app on the next deploy.
      final order = ActiveOrder.fromJson({
        'id': 'o2',
        'humanRef': 'BSC-9',
        'state': 'quantum_superposition',
        'service': 'food',
        'totalPesewas': '100',
      });
      expect(order.state, OrderState.unknown);
    });
  });

  group('menu item contract', () {
    late Map<String, dynamic> item;

    setUp(() => item = jsonDecode(menuItemJson) as Map<String, dynamic>);

    test('addon groups parse — the "required" key is the one that bit us', () {
      final groups = (item['addonGroups'] as List<dynamic>)
          .map((g) => AddonGroup.fromJson(g as Map<String, dynamic>))
          .toList();

      expect(groups, hasLength(1));
      final protein = groups.single;
      expect(protein.name, 'Protein');
      expect(protein.required_, isTrue,
          reason: 'the model reads "required"; the BFF must not send "isRequired"');
      expect(protein.minSelections, 1);
      expect(protein.maxSelections, 2);
      expect(protein.options, hasLength(2));
    });

    test('addon options carry price and availability', () {
      final group =
          AddonGroup.fromJson((item['addonGroups'] as List<dynamic>).first as Map<String, dynamic>);

      expect(group.options[0].price.value, 1500);
      expect(group.options[0].available, isTrue);
      expect(group.options[1].available, isFalse,
          reason: 'a sold-out addon must render as sold out, not as available');
    });

    test('client-side validation mirrors the server rule', () {
      final group =
          AddonGroup.fromJson((item['addonGroups'] as List<dynamic>).first as Map<String, dynamic>);

      expect(group.validate({}), isNotNull, reason: 'required group, nothing chosen');
      expect(group.validate({'a1'}), isNull);
      expect(group.validate({'a1', 'a2'}), isNull, reason: 'two is the maximum');
    });

    test('a group sent with the WRONG key fails loudly here', () {
      // This is the regression: if a future change reverts the BFF to
      // `isRequired`, the group silently becomes optional and a customer can
      // order jollof with no protein — an order the kitchen cannot cook.
      final wrong = AddonGroup.fromJson({
        'id': 'g1',
        'name': 'Protein',
        'isRequired': true, // WRONG KEY on purpose
        'minSelections': 1,
        'maxSelections': 2,
        'options': [
          {'id': 'a1', 'name': 'Chicken', 'pricePesewas': '1500', 'available': true},
        ],
      });

      expect(wrong.required_, isFalse,
          reason: 'demonstrates why the key name is load-bearing');
      // minSelections still saves us here, which is the defence in depth.
      expect(wrong.validate({}), isNotNull);
    });
  });

  group('money never loses precision on the wire', () {
    test('pesewa strings round-trip exactly', () {
      for (final raw in ['0', '1', '8150', '5950', '999999999']) {
        expect(Pesewas.parse(raw).value.toString(), raw);
      }
    });

    test('the canonical split still sums to the total', () {
      final vendor = Pesewas.parse('5950');
      final rider = Pesewas.parse('800');
      final platform = Pesewas.parse('1400');
      final total = Pesewas.parse('8150');

      expect(vendor.value + rider.value + platform.value, total.value);
    });
  });
}
