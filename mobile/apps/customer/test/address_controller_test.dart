import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/state/address_controller.dart';

const osu = LatLng(5.5560, -0.1821);
const london = LatLng(51.5074, -0.1278);
const kumasi = LatLng(6.6885, -1.6244);

AddressController ready() => AddressController()
  ..setPosition(osu)
  ..setLandmark('behind the MTN mast, blue gate');

void main() {
  group('GhanaPostGPS', () {
    test('accepts the canonical form', () {
      expect(GhanaPostAddress.isValid('GA-123-4567'), isTrue);
      expect(GhanaPostAddress.isValid('AK-0392-1234'), isTrue);
    });

    test('normalises what people actually type', () {
      expect(GhanaPostAddress.normalise('ga 123 4567'), 'GA-123-4567');
      expect(GhanaPostAddress.normalise('  ga-123-4567 '), 'GA-123-4567');
      expect(GhanaPostAddress.normalise('GA_123_4567'), 'GA-123-4567');
    });

    test('rejects malformed codes', () {
      for (final bad in ['123-456', 'GA-12-34', 'GHANA-123-4567', '']) {
        expect(GhanaPostAddress.isValid(bad), isFalse, reason: bad);
      }
    });
  });

  group('the pin is authoritative', () {
    test('a pin inside Ghana is accepted', () {
      final c = AddressController();
      expect(c.setPosition(osu), isTrue);
      expect(c.position, osu);
      expect(c.error, isNull);
    });

    test('a pin outside Ghana is refused with a clear message', () {
      final c = AddressController();
      expect(c.setPosition(london), isFalse);
      expect(c.position, isNull);
      expect(c.error, contains('outside Ghana'));
    });

    test('Kumasi is inside Ghana — the box is not Accra-only', () {
      expect(AddressController().setPosition(kumasi), isTrue);
    });

    test('moving the pin discards the old area name', () {
      final c = AddressController()
        ..setPosition(osu)
        ..setAreaName('Osu');
      expect(c.areaName, 'Osu');
      c.setPosition(kumasi);
      expect(c.areaName, isNull,
          reason: 'a stale area name would mislabel the new pin');
    });
  });

  group('what is required to save', () {
    test('a pin alone is not enough — the landmark is what riders read', () {
      final c = AddressController()..setPosition(osu);
      expect(c.blocker, contains('landmark'));
      expect(c.canSave, isFalse);
    });

    test('a pin plus a landmark is sufficient', () {
      expect(ready().canSave, isTrue);
    });

    test('a token landmark is rejected', () {
      final c = AddressController()
        ..setPosition(osu)
        ..setLandmark('x');
      expect(c.canSave, isFalse);
    });

    test('no pin means nothing else matters', () {
      final c = AddressController()..setLandmark('behind the MTN mast');
      expect(c.blocker, 'Drop a pin on your location');
    });

    test('an area name is NOT required — many areas have no name in Google',
        () {
      final c = ready();
      expect(c.areaName, isNull);
      expect(c.canSave, isTrue);
    });

    test('GhanaPostGPS is NOT required', () {
      expect(ready().canSave, isTrue);
    });

    test('instructions are NOT required, only suggested', () {
      final c = ready();
      expect(c.canSave, isTrue);
      expect(c.suggestionsForUser, contains(
          'Delivery instructions help riders find you faster'));
    });
  });

  group('GhanaPost entry', () {
    test('a valid code is stored normalised', () {
      final c = ready();
      expect(c.setGhanaPost('ga 123 4567'), isTrue);
      expect(c.draft.ghanaPost, 'GA-123-4567');
      expect(c.error, isNull);
    });

    test('a malformed code shows an inline example, not a submit failure', () {
      final c = ready();
      expect(c.setGhanaPost('nonsense'), isFalse);
      expect(c.error, contains('GA-123-4567'));
    });

    test('clearing the field is always allowed', () {
      final c = ready()..setGhanaPost('GA-123-4567');
      expect(c.setGhanaPost(''), isTrue);
      expect(c.draft.ghanaPost, isNull);
      expect(c.error, isNull);
    });
  });

  group('place search cost control', () {
    test('fewer than 3 characters never queries Google', () {
      final c = AddressController();
      expect(c.shouldQuery('o'), isFalse);
      expect(c.shouldQuery('os'), isFalse);
      expect(c.shouldQuery('osu'), isTrue);
      expect(c.shouldQuery('   '), isFalse);
    });

    test('suggestions clear when the mode changes', () {
      final c = AddressController()
        ..setSuggestions([
          const PlaceSuggestion(
              placeId: 'p1', mainText: 'Osu', secondaryText: 'Accra'),
        ]);
      expect(c.suggestions.length, 1);
      c.setMode(AddressEntryMode.ghanaPost);
      expect(c.suggestions, isEmpty);
    });
  });

  group('text normalisation', () {
    test('blank fields become null rather than empty strings', () {
      final c = ready()
        ..setInstructions('   ')
        ..setContactPhone('  ');
      expect(c.draft.instructions, isNull);
      expect(c.draft.contactPhone, isNull);
    });

    test('an empty label falls back to Home', () {
      final c = ready()..setLabel('  ');
      expect(c.draft.label, 'Home');
    });

    test('values are trimmed', () {
      final c = ready()..setInstructions('  call when you arrive  ');
      expect(c.draft.instructions, 'call when you arrive');
    });
  });

  group('payload', () {
    test('carries the pin and landmark, omits empty optionals', () {
      final p = ready().toPayload();
      expect(p['lat'], osu.lat);
      expect(p['lng'], osu.lng);
      expect(p['landmark'], 'behind the MTN mast, blue gate');
      expect(p.containsKey('ghanapostAddress'), isFalse);
      expect(p.containsKey('instructions'), isFalse);
    });

    test('includes optionals once provided', () {
      final c = ready()
        ..setAreaName('Osu')
        ..setInstructions('call when you arrive')
        ..setGhanaPost('GA-123-4567')
        ..setContactPhone('0551234987');
      final p = c.toPayload();
      expect(p['areaName'], 'Osu');
      expect(p['instructions'], 'call when you arrive');
      expect(p['ghanapostAddress'], 'GA-123-4567');
      expect(p['contactPhone'], '0551234987');
    });
  });

  group('editing an existing address', () {
    test('loads every field back into the draft', () {
      final existing = Address.fromJson({
        'id': 'a1', 'label': 'Work', 'lat': 5.58, 'lng': -0.175,
        'areaName': 'Cantonments', 'landmark': 'opposite the police station',
        'instructions': 'second floor', 'ghanapostAddress': 'GA-543-2100',
      });
      final c = AddressController()..loadFrom(existing);
      expect(c.draft.label, 'Work');
      expect(c.draft.landmark, 'opposite the police station');
      expect(c.draft.ghanaPost, 'GA-543-2100');
      expect(c.canSave, isTrue);
    });
  });

  group('notifications', () {
    test('every change rebuilds the UI', () {
      final c = AddressController();
      var n = 0;
      c.addListener(() => n++);
      c.setPosition(osu);
      c.setLandmark('blue gate');
      c.setMode(AddressEntryMode.ghanaPost);
      expect(n, 3);
    });
  });
}
