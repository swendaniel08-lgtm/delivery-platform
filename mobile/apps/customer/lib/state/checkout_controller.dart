/// Checkout state. PDF §6, §7.
///
/// The server is authoritative for every figure here — this class holds the
/// quote it returned and the customer's choices. It deliberately does not
/// compute totals from the cart: a client-side total that disagrees with the
/// server is worse than no total at all.
///
/// COD eligibility is mirrored client-side so an ineligible option is
/// disabled with a reason rather than failing at the last tap.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

enum PaymentMethod { momo, card, cash, wallet }

extension PaymentMethodX on PaymentMethod {
  String get label => switch (this) {
        PaymentMethod.momo => 'Mobile Money',
        PaymentMethod.card => 'Card',
        PaymentMethod.cash => 'Cash on delivery',
        PaymentMethod.wallet => 'Besonc wallet',
      };

  String get wire => switch (this) {
        PaymentMethod.momo || PaymentMethod.card => 'prepaid',
        PaymentMethod.cash => 'cod',
        PaymentMethod.wallet => 'wallet',
      };
}

/// The server's quote. Every field arrives preformatted or as pesewa strings;
/// nothing here is recalculated on the device.
class CheckoutQuote {
  const CheckoutQuote({
    required this.itemTotal,
    required this.deliveryFee,
    required this.serviceFee,
    required this.total,
    this.codEligible = false,
    this.codReason,
  });

  final Pesewas itemTotal;
  final Pesewas deliveryFee;
  final Pesewas serviceFee;
  final Pesewas total;
  final bool codEligible;

  /// Why cash is unavailable — shown next to the disabled option.
  final String? codReason;

  factory CheckoutQuote.fromJson(Map<String, dynamic> j) => CheckoutQuote(
        itemTotal: Pesewas.parse(j['itemTotalPesewas'] as String),
        deliveryFee: Pesewas.parse(j['deliveryFeePesewas'] as String),
        serviceFee: Pesewas.parse(j['serviceFeePesewas'] as String),
        total: Pesewas.parse(j['totalPesewas'] as String),
        codEligible: j['codEligible'] as bool? ?? false,
        codReason: j['codReason'] as String?,
      );
}

enum CheckoutStage {
  editing,        // choosing address and payment
  submitting,     // POST in flight
  awaitingMomo,   // customer approving the prompt on their handset
  confirmed,
  failed,
}

class CheckoutController extends ChangeNotifier {
  CheckoutController({
    required this.walletBalance,
    Address? address,
    PaymentMethod method = PaymentMethod.momo,
  })  : _address = address,
        _method = method;

  final Pesewas walletBalance;

  Address? _address;
  PaymentMethod _method;
  CheckoutQuote? _quote;
  CheckoutStage _stage = CheckoutStage.editing;
  String? _error;
  String? _momoPhone;
  String? _prescriptionUrl;

  /// Stable across retries so a timed-out submit cannot create two orders.
  String? _idempotencyKey;

  Address? get address => _address;
  PaymentMethod get method => _method;
  CheckoutQuote? get quote => _quote;
  CheckoutStage get stage => _stage;
  String? get error => _error;
  String? get momoPhone => _momoPhone;
  String? get idempotencyKey => _idempotencyKey;
  bool get busy =>
      _stage == CheckoutStage.submitting || _stage == CheckoutStage.awaitingMomo;

  void setAddress(Address value) {
    _address = value;
    // The delivery fee depends on distance, so the old quote is now stale.
    _quote = null;
    notifyListeners();
  }

  void setQuote(CheckoutQuote value) {
    _quote = value;
    // If cash was selected and is no longer allowed, fall back rather than
    // letting the customer submit something the server will reject.
    if (_method == PaymentMethod.cash && !value.codEligible) {
      _method = PaymentMethod.momo;
    }
    notifyListeners();
  }

  void setMethod(PaymentMethod value) {
    if (!isMethodAvailable(value)) return;
    _method = value;
    notifyListeners();
  }

  void setMomoPhone(String? value) {
    _momoPhone = (value == null || value.trim().isEmpty) ? null : value.trim();
    notifyListeners();
  }

  void setPrescription(String? url) {
    _prescriptionUrl = url;
    notifyListeners();
  }

  /* ---------------- availability ---------------- */

  bool isMethodAvailable(PaymentMethod m) => switch (m) {
        PaymentMethod.cash => _quote?.codEligible ?? false,
        // Wallet only when it covers the whole total — partial payment is a
        // Phase 2 feature and half-paying an order is worse than not offering it.
        PaymentMethod.wallet =>
          _quote != null && walletBalance.value >= _quote!.total.value,
        _ => true,
      };

  String? unavailableReason(PaymentMethod m) {
    if (isMethodAvailable(m)) return null;
    return switch (m) {
      PaymentMethod.cash =>
        _quote?.codReason ?? 'Cash is not available for this order',
      PaymentMethod.wallet =>
        'Your wallet has ${walletBalance.display}, which is not enough',
      _ => null,
    };
  }

  /* ---------------- validation ---------------- */

  /// First blocker, or null when the order can be placed.
  String? get blocker {
    if (_address == null) return 'Choose a delivery address';
    if (_quote == null) return 'Calculating your total…';
    if (_method == PaymentMethod.momo &&
        (_momoPhone == null || _momoPhone!.isEmpty)) {
      return 'Enter the mobile money number to charge';
    }
    if (_method == PaymentMethod.momo && !_isGhanaMobile(_momoPhone!)) {
      return 'Enter a valid Ghana mobile number';
    }
    if (!isMethodAvailable(_method)) {
      return unavailableReason(_method);
    }
    return null;
  }

  bool get canSubmit => blocker == null && !busy;

  /// Mirrors the server's E.164 rule so the customer is told immediately.
  static bool _isGhanaMobile(String raw) {
    final digits = raw.replaceAll(RegExp(r'[\s\-()]'), '');
    final national = digits.startsWith('+233')
        ? digits.substring(4)
        : digits.startsWith('233')
            ? digits.substring(3)
            : digits.startsWith('0')
                ? digits.substring(1)
                : digits;
    return RegExp(r'^[2356]\d{8}$').hasMatch(national);
  }

  /* ---------------- submission ---------------- */

  /// Payload for POST /checkout. No amounts: the server re-prices.
  Map<String, dynamic> payload(Map<String, dynamic> cartPayload) => {
        ...cartPayload,
        'addressId': _address!.id,
        'paymentIntent': _method.wire,
        if (_method == PaymentMethod.momo) 'momoPhone': _momoPhone,
        if (_prescriptionUrl != null) 'prescriptionUrl': _prescriptionUrl,
      };

  /// Generates the idempotency key once and reuses it for every retry of
  /// THIS attempt, so a network timeout cannot produce two orders.
  String beginSubmit(String Function() generateKey) {
    _idempotencyKey ??= generateKey();
    _stage = CheckoutStage.submitting;
    _error = null;
    notifyListeners();
    return _idempotencyKey!;
  }

  /// Mobile money is asynchronous: the customer approves a prompt on their
  /// handset and the webhook confirms. The UI must wait, not celebrate.
  void awaitingMomoApproval() {
    _stage = CheckoutStage.awaitingMomo;
    notifyListeners();
  }

  void confirmed() {
    _stage = CheckoutStage.confirmed;
    _error = null;
    notifyListeners();
  }

  /// A failure keeps the SAME idempotency key so the retry is still safe.
  void failed(String message) {
    _stage = CheckoutStage.failed;
    _error = message;
    notifyListeners();
  }

  /// Only call this when the customer changes the order, which makes it a
  /// genuinely different submission.
  void resetIdempotency() {
    _idempotencyKey = null;
  }

  void backToEditing() {
    _stage = CheckoutStage.editing;
    _error = null;
    notifyListeners();
  }
}
