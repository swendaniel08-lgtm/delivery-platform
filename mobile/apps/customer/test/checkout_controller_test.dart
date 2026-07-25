import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/state/checkout_controller.dart';

Address osu() => Address.fromJson({
      'id': 'a1', 'label': 'Home', 'lat': 5.556, 'lng': -0.182,
      'areaName': 'Osu', 'landmark': 'behind the MTN mast',
    });

CheckoutQuote quote({
  bool codEligible = true,
  String? codReason,
  String total = '8150',
}) =>
    CheckoutQuote.fromJson({
      'itemTotalPesewas': '7000',
      'deliveryFeePesewas': '800',
      'serviceFeePesewas': '350',
      'totalPesewas': total,
      'codEligible': codEligible,
      if (codReason != null) 'codReason': codReason,
    });

CheckoutController ready({
  Pesewas wallet = const Pesewas(0),
  bool codEligible = true,
  String? codReason,
  PaymentMethod method = PaymentMethod.momo,
}) {
  final c = CheckoutController(walletBalance: wallet, method: method)
    ..setAddress(osu())
    ..setQuote(quote(codEligible: codEligible, codReason: codReason));
  if (method == PaymentMethod.momo) c.setMomoPhone('0551234987');
  return c;
}

void main() {
  group('quote handling', () {
    test('the server total is used verbatim, never recomputed', () {
      final c = ready();
      expect(c.quote!.total.display, 'GHS 81.50');
      expect(c.quote!.deliveryFee.display, 'GHS 8.00');
    });

    test('changing address invalidates the quote — distance changed', () {
      final c = ready();
      expect(c.quote, isNotNull);
      c.setAddress(Address.fromJson({
        'id': 'a2', 'label': 'Work', 'lat': 5.60, 'lng': -0.20,
      }));
      expect(c.quote, isNull);
      expect(c.blocker, contains('Calculating'));
    });
  });

  group('COD availability (PDF §7)', () {
    test('cash is offered when the server says it is eligible', () {
      final c = ready();
      expect(c.isMethodAvailable(PaymentMethod.cash), isTrue);
      c.setMethod(PaymentMethod.cash);
      expect(c.method, PaymentMethod.cash);
    });

    test('an ineligible cash option is disabled WITH the server reason', () {
      final c = ready(
        codEligible: false,
        codReason: 'Shop orders are prepaid only',
      );
      expect(c.isMethodAvailable(PaymentMethod.cash), isFalse);
      expect(c.unavailableReason(PaymentMethod.cash),
          'Shop orders are prepaid only');
    });

    test('selecting an unavailable method is ignored, not silently accepted', () {
      final c = ready(codEligible: false);
      c.setMethod(PaymentMethod.cash);
      expect(c.method, PaymentMethod.momo, reason: 'selection must not stick');
    });

    test('a new quote that removes COD eligibility falls back safely', () {
      final c = ready();
      c.setMethod(PaymentMethod.cash);
      expect(c.method, PaymentMethod.cash);

      // the customer added a Shop item, so the server withdraws COD
      c.setQuote(quote(codEligible: false, codReason: 'Shop is prepaid only'));
      expect(c.method, PaymentMethod.momo,
          reason: 'must not submit a method the server will reject');
    });
  });

  group('wallet availability', () {
    test('wallet is offered only when it covers the whole total', () {
      final enough = ready(wallet: const Pesewas(10000));
      expect(enough.isMethodAvailable(PaymentMethod.wallet), isTrue);

      final short = ready(wallet: const Pesewas(5000));
      expect(short.isMethodAvailable(PaymentMethod.wallet), isFalse);
      expect(short.unavailableReason(PaymentMethod.wallet),
          contains('GHS 50.00'));
    });

    test('exactly the total counts as enough', () {
      final c = ready(wallet: const Pesewas(8150));
      expect(c.isMethodAvailable(PaymentMethod.wallet), isTrue);
    });
  });

  group('validation before submit', () {
    test('an address is required first', () {
      final c = CheckoutController(walletBalance: const Pesewas(0));
      expect(c.blocker, 'Choose a delivery address');
      expect(c.canSubmit, isFalse);
    });

    test('mobile money requires a number', () {
      final c = CheckoutController(walletBalance: const Pesewas(0))
        ..setAddress(osu())
        ..setQuote(quote());
      expect(c.blocker, contains('mobile money number'));
    });

    test('the Ghana number rule is mirrored client-side', () {
      final c = ready();
      for (final bad in ['12345', '0151234987', 'abcdefghi']) {
        c.setMomoPhone(bad);
        expect(c.blocker, 'Enter a valid Ghana mobile number',
            reason: '$bad should be rejected');
      }
      for (final good in ['0551234987', '+233551234987', '233 55 123 4987']) {
        c.setMomoPhone(good);
        expect(c.blocker, isNull, reason: '$good should be accepted');
      }
    });

    test('cash needs no phone number', () {
      final c = ready(method: PaymentMethod.momo);
      c.setMethod(PaymentMethod.cash);
      c.setMomoPhone(null);
      expect(c.canSubmit, isTrue);
    });

    test('a complete order can be submitted', () {
      expect(ready().canSubmit, isTrue);
    });
  });

  group('payload', () {
    test('carries ids and intent — never amounts', () {
      final c = ready();
      final payload = c.payload({'storeId': 's1', 'lines': []});
      final encoded = payload.toString();

      expect(payload['addressId'], 'a1');
      expect(payload['paymentIntent'], 'prepaid');
      expect(payload['momoPhone'], '0551234987');
      expect(encoded.contains('8150'), isFalse,
          reason: 'the client must never send a total');
    });

    test('cash maps to the cod intent', () {
      final c = ready()..setMethod(PaymentMethod.cash);
      expect(c.payload({})['paymentIntent'], 'cod');
    });

    test('a prescription url is included when uploaded', () {
      final c = ready()..setPrescription('https://cdn/rx.jpg');
      expect(c.payload({})['prescriptionUrl'], 'https://cdn/rx.jpg');
    });
  });

  group('idempotency across retries', () {
    test('the key is generated once and REUSED after a failure', () {
      final c = ready();
      var generated = 0;
      String gen() => 'key-${++generated}';

      final first = c.beginSubmit(gen);
      c.failed('network timeout');
      final second = c.beginSubmit(gen);

      expect(first, second,
          reason: 'a new key per attempt would let a timeout create two orders');
      expect(generated, 1);
    });

    test('changing the order resets the key — it is a new submission', () {
      final c = ready();
      final first = c.beginSubmit(() => 'key-a');
      c.failed('declined');
      c.resetIdempotency();
      final second = c.beginSubmit(() => 'key-b');
      expect(first, isNot(second));
    });
  });

  group('stages', () {
    test('mobile money waits for handset approval before celebrating', () {
      final c = ready();
      c.beginSubmit(() => 'k');
      expect(c.stage, CheckoutStage.submitting);

      c.awaitingMomoApproval();
      expect(c.stage, CheckoutStage.awaitingMomo);
      expect(c.busy, isTrue, reason: 'the UI must stay locked');

      c.confirmed();
      expect(c.stage, CheckoutStage.confirmed);
      expect(c.busy, isFalse);
    });

    test('a failure surfaces the message and unlocks for retry', () {
      final c = ready();
      c.beginSubmit(() => 'k');
      c.failed('Insufficient mobile money balance');
      expect(c.stage, CheckoutStage.failed);
      expect(c.error, 'Insufficient mobile money balance');
      expect(c.busy, isFalse);
    });

    test('cannot submit while already submitting', () {
      final c = ready();
      c.beginSubmit(() => 'k');
      expect(c.canSubmit, isFalse, reason: 'guards against double-tap');
    });

    test('going back to editing clears the error', () {
      final c = ready();
      c.beginSubmit(() => 'k');
      c.failed('declined');
      c.backToEditing();
      expect(c.error, isNull);
      expect(c.canSubmit, isTrue);
    });
  });

  group('notifications', () {
    test('every state change rebuilds the UI', () {
      final c = ready();
      var n = 0;
      c.addListener(() => n++);
      c.setMethod(PaymentMethod.cash);
      c.setMomoPhone('0201234567');
      c.beginSubmit(() => 'k');
      c.failed('x');
      expect(n, 4);
    });
  });
}
