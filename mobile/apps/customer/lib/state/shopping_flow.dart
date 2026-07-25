/// Ties the store page, the cart and checkout to the BFF.
///
/// The controllers underneath are deliberately pure — they hold state and
/// enforce rules but never touch the network. This is the one place that
/// does, which keeps the rules testable without a socket and keeps the
/// retry/idempotency logic in a single readable file.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_models/besonc_models.dart';

import '../screens/vendor_screen.dart';
import 'cart_controller.dart';
import 'checkout_controller.dart';

enum StoreLoad { loading, ready, failed }

/// Loads one store's menu.
class StorePageController extends ChangeNotifier {
  StorePageController({required BesoncApi api, required this.storeId})
      : _api = api;

  final BesoncApi _api;
  final String storeId;

  StoreLoad _state = StoreLoad.loading;
  StoreCard? _store;
  List<MenuCategory> _categories = const [];
  String? _error;

  StoreLoad get state => _state;
  StoreCard? get store => _store;
  List<MenuCategory> get categories => _categories;
  String? get error => _error;

  Future<void> load() async {
    _state = _store == null ? StoreLoad.loading : _state;
    notifyListeners();
    try {
      final json = await _api.get('/api/customer/stores/$storeId');
      _store = StoreCard.fromJson(json['store'] as Map<String, dynamic>);
      _categories = (json['categories'] as List<dynamic>? ?? [])
          .map((c) => MenuCategory.fromJson(c as Map<String, dynamic>))
          .toList();
      _state = StoreLoad.ready;
      _error = null;
    } on ApiException catch (e) {
      _fail(e.message);
    } on NetworkException catch (e) {
      _fail(e.message);
    }
    notifyListeners();
  }

  void _fail(String message) {
    _error = message;
    if (_store == null) _state = StoreLoad.failed;
  }
}

/* ------------------------------------------------------------------ */

/// Drives checkout: quoting, placing, and waiting for confirmation.
class CheckoutFlow {
  CheckoutFlow({
    required BesoncApi api,
    required this.cart,
    required this.checkout,
  }) : _api = api;

  final BesoncApi _api;
  final CartController cart;
  final CheckoutController checkout;

  /// Ask the server what this cart costs.
  ///
  /// Called on entering checkout and again whenever the cart changes. The
  /// app never adds anything up itself, so this is the only source of a
  /// total anywhere in the customer experience.
  Future<void> refreshQuote() async {
    if (cart.isEmpty) return;
    try {
      final json = await _api.post(
        '/api/customer/checkout/quote',
        body: cart.toCheckoutPayload(),
      );
      checkout.setQuote(CheckoutQuote.fromJson(json));
    } on ApiException catch (e) {
      checkout.failed(e.message);
    } on NetworkException catch (e) {
      checkout.failed(e.message);
    } catch (e) {
      // A malformed quote must not leave the button spinning forever with
      // no explanation — surface it like any other failure.
      checkout.failed('Could not price your order. Please try again.');
    }
  }

  /// Place the order.
  ///
  /// Returns the order id on success. The idempotency key is generated once
  /// per attempt and REUSED across retries, so a timeout on a Ghanaian
  /// mobile network cannot produce two orders the customer pays for twice.
  Future<String?> placeOrder() async {
    if (!checkout.canSubmit) return null;

    final key = checkout.beginSubmit(
      () => _api.idempotencyKeyFor('checkout', cart.storeId ?? 'cart'),
    );

    try {
      final json = await _api.post(
        '/api/customer/checkout',
        body: checkout.payload(cart.toCheckoutPayload()),
        idempotencyKey: key,
      );

      final orderId = json['orderId'] as String?;

      if (json['requiresApproval'] == true) {
        // Mobile money: the customer still has to approve a prompt on their
        // handset, and the webhook is what confirms it. Showing success here
        // would be a lie the vendor then acts on.
        checkout.awaitingMomoApproval();
      } else {
        checkout.confirmed();
        // Only clear the cart once the order genuinely exists. Clearing
        // optimistically loses the customer's work if the call failed.
        cart.clear();
      }
      return orderId;
    } on ApiException catch (e) {
      checkout.failed(e.message);
      return null;
    } on NetworkException catch (e) {
      checkout.failed(e.message);
      return null;
    }
  }

  /// Poll until the payment webhook lands.
  ///
  /// Bounded: after [attempts] the customer is told to check their order
  /// history rather than being left on a spinner forever. A momo prompt
  /// that is never approved must not hang the app.
  Future<bool> awaitConfirmation(
    String orderId, {
    int attempts = 20,
    Duration interval = const Duration(seconds: 3),
    Future<void> Function(Duration)? sleep,
  }) async {
    final wait = sleep ?? Future<void>.delayed;

    for (var i = 0; i < attempts; i++) {
      await wait(interval);
      try {
        final json = await _api.get('/api/customer/home');
        final active = json['activeOrder'] as Map<String, dynamic>?;
        if (active != null && active['id'] == orderId) {
          final state = OrderState.fromWire(active['state'] as String? ?? '');
          if (state != OrderState.pendingPayment) {
            checkout.confirmed();
            cart.clear();
            return true;
          }
        }
      } catch (_) {
        // A dropped poll on mobile data is routine; keep waiting.
      }
    }

    checkout.failed(
      'We have not received your payment yet. '
      'If money left your account, check your orders in a moment.',
    );
    return false;
  }
}
