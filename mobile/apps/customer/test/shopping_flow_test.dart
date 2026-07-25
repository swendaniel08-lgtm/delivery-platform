/// The full shopping journey against a scripted transport.
///
/// home → store → add to cart → cart → checkout → order placed.
///
/// This is the test that proves the customer app can actually take money.
/// It drives the real widgets and the real BesoncApi; only the socket is
/// replaced.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/app/app.dart';
import 'package:besonc_customer/app/environment.dart';
import 'package:besonc_customer/state/cart_controller.dart';
import 'package:besonc_customer/state/checkout_controller.dart';
import 'package:besonc_customer/state/shopping_flow.dart';

class RouteTransport implements HttpTransport {
  RouteTransport(this.routes);

  final Map<String, (int, Map<String, dynamic>)> routes;
  final List<String> calls = [];
  final List<String> idempotencyKeys = [];
  Object? failWith;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    final path = Uri.parse(url).path;
    calls.add('$method $path');
    final key = headers['idempotency-key'];
    if (key != null) idempotencyKeys.add(key);
    if (failWith != null) throw failWith!;

    // Longest prefix wins so /checkout/quote is not shadowed by /checkout.
    var bestLen = -1;
    int? bestStatus;
    Map<String, dynamic>? bestBody;
    for (final e in routes.entries) {
      final parts = e.key.split(' ');
      if (parts[0] != method) continue;
      if (!path.endsWith(parts[1])) continue;
      if (parts[1].length > bestLen) {
        bestLen = parts[1].length;
        bestStatus = e.value.$1;
        bestBody = e.value.$2;
      }
    }
    if (bestStatus != null) {
      return HttpResponse(bestStatus, jsonEncode(bestBody));
    }
    return HttpResponse(404, jsonEncode({'title': 'no route for $path'}));
  }
}

final _home = <String, dynamic>{
  'deliveringTo': {
    'label': 'Home', 'areaName': 'Osu', 'landmark': 'behind the MTN mast',
    'lat': 5.5560, 'lng': -0.1821,
  },
  'services': [{'key': 'food', 'label': 'Food', 'enabled': true}],
  'activeOrder': null,
  'popularNearYou': [{
    'id': 's1', 'name': 'Auntie Muni Waakye', 'rating': 4.7,
    'prepEstimate': '20-40 min', 'deliveryFee': 'GHS 8.00', 'isOpen': true,
  }],
  'topRated': <dynamic>[],
  'newOnBesonc': <dynamic>[],
};

final _store = <String, dynamic>{
  'store': {
    'id': 's1', 'name': 'Auntie Muni Waakye', 'rating': 4.7,
    'prepEstimate': '20-40 min', 'deliveryFee': 'GHS 8.00', 'isOpen': true,
  },
  'categories': [{
    'name': 'Menu',
    'items': [{
      'id': 'i1', 'name': 'Jollof Rice', 'basePricePesewas': '3500',
      'available': true, 'addonGroups': <dynamic>[],
    }],
  }],
};

final _quote = <String, dynamic>{
  'itemTotalPesewas': '7000',
  'deliveryFeePesewas': '800',
  'serviceFeePesewas': '350',
  'totalPesewas': '8150',
  'codEligible': true,
};

final _addresses = <String, dynamic>{
  'addresses': [{
    'id': 'a1', 'label': 'Home', 'latitude': 5.5560, 'longitude': -0.1821,
    'landmark': 'behind the MTN mast', 'isDefault': true,
  }],
};

AppDependencies buildDeps(RouteTransport transport, {CartController? cart}) {
  late final AuthController auth;
  final api = BesoncApi(
    baseUrl: 'http://test',
    transport: transport,
    maxRetries: 0,
    backoff: (_) => Duration.zero,
    onAuthLost: () => auth.onSessionExpired(),
  );
  auth = AuthController(api: api, role: AuthRole.customer);
  return AppDependencies(
    api: api, auth: auth, cart: cart,
    environment: const BesoncEnvironment(
      apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', name: 'test',
    ),
  );
}

RouteTransport fullStubs({
  Map<String, dynamic>? quote,
  (int, Map<String, dynamic>)? checkout,
}) =>
    RouteTransport({
      'GET /api/users/me': (200, {
        'id': 'u1', 'phone': '+233244123456', 'role': 'customer',
        'firstName': 'Ama',
      }),
      'GET /api/users/me/addresses': (200, _addresses),
      'GET /api/customer/home': (200, _home),
      'GET /api/customer/stores/s1': (200, _store),
      'POST /api/customer/checkout/quote': (201, quote ?? _quote),
      'POST /api/customer/checkout': checkout ?? (201, {
        'orderId': 'o-1', 'humanRef': '#515204', 'state': 'pending_payment',
        'totalPesewas': '8150', 'requiresApproval': false,
      }),
    });

void main() {
  Future<void> pumpApp(WidgetTester t, AppDependencies deps) async {
    await t.binding.setSurfaceSize(const Size(360, 800));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(BesoncCustomerApp(deps: deps));
    await t.pumpAndSettle();
  }

  Future<void> scrollTo(WidgetTester t, Finder f) async {
    await t.scrollUntilVisible(f, 120, scrollable: find.byType(Scrollable).first);
    await t.pump();
  }

  group('the whole journey', () {
    testWidgets('home → store → cart → checkout → order placed', (t) async {
      final transport = fullStubs();
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');
      await pumpApp(t, deps);

      // 1. Home shows the vendor.
      expect(find.text('Auntie Muni Waakye'), findsWidgets);

      // 2. Open the store.
      await t.tap(find.text('Auntie Muni Waakye').first);
      await t.pumpAndSettle();
      expect(find.text('Jollof Rice'), findsOneWidget);
      expect(transport.calls, contains('GET /api/customer/stores/s1'));

      // 3. Add it to the cart.
      await t.tap(find.byKey(const Key('menu-item-i1')));
      await t.pumpAndSettle();
      expect(deps.cart.itemCount, 1);

      // 4. Open the cart.
      await t.tap(find.byKey(const Key('view-cart')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('cart-subtotal')), findsOneWidget);

      // 5. Checkout — the SERVER's quote is what renders.
      await t.tap(find.byKey(const Key('cart-checkout')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('quote-total')), findsOneWidget);
      expect(find.text('GHS 81.50'), findsWidgets);
      expect(transport.calls, contains('POST /api/customer/checkout/quote'));

      // 6. Pay with cash (no momo number needed) and place the order.
      await scrollTo(t, find.byKey(const Key('pay-cash')));
      await t.tap(find.byKey(const Key('pay-cash')));
      await t.pump();

      await t.tap(find.byKey(const Key('place-order')));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('checkout-confirmed')), findsOneWidget);
      expect(transport.calls, contains('POST /api/customer/checkout'));
      expect(deps.cart.isEmpty, isTrue,
          reason: 'the cart is cleared only after the order really exists');
    });

    testWidgets('the cart survives a failed checkout', (t) async {
      final transport = fullStubs(
        checkout: (422, {
          'title': 'Validation Failed',
          'detail': 'Cash on delivery is unavailable after 9pm',
        }),
      );
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');
      await pumpApp(t, deps);

      await t.tap(find.text('Auntie Muni Waakye').first);
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('menu-item-i1')));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('view-cart')));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('cart-checkout')));
      await t.pumpAndSettle();

      await scrollTo(t, find.byKey(const Key('pay-cash')));
      await t.tap(find.byKey(const Key('pay-cash')));
      await t.pump();
      await t.tap(find.byKey(const Key('place-order')));
      await t.pumpAndSettle();

      expect(deps.cart.isEmpty, isFalse,
          reason: 'losing the cart on a failed payment is unforgivable');
      await scrollTo(t, find.byKey(const Key('checkout-error')));
      expect(find.textContaining('after 9pm'), findsOneWidget);
    });
  });

  group('CheckoutFlow', () {
    CheckoutFlow flowWith(RouteTransport transport, {CartController? cart}) {
      final api = BesoncApi(
        baseUrl: 'http://t', transport: transport, maxRetries: 0,
        backoff: (_) => Duration.zero,
      );
      final c = cart ?? (CartController()
        ..add(CartItemDraft(
          itemId: 'i1', name: 'Jollof Rice', basePrice: const Pesewas(3500),
          storeId: 's1', storeName: 'Auntie Muni', quantity: 2,
        )));
      return CheckoutFlow(
        api: api,
        cart: c,
        checkout: CheckoutController(walletBalance: const Pesewas(0)),
      );
    }

    test('the quote comes entirely from the server', () async {
      final flow = flowWith(fullStubs());
      await flow.refreshQuote();

      final q = flow.checkout.quote!;
      expect(q.itemTotal.value, 7000);
      expect(q.deliveryFee.value, 800);
      expect(q.serviceFee.value, 350);
      expect(q.total.value, 8150);
      expect(q.codEligible, isTrue);
    });

    test('an empty cart is never quoted', () async {
      final transport = fullStubs();
      final flow = flowWith(transport, cart: CartController());
      await flow.refreshQuote();
      expect(transport.calls, isEmpty);
    });

    test('A RETRY REUSES THE SAME IDEMPOTENCY KEY', () async {
      final transport = fullStubs();
      final flow = flowWith(transport);
      // Address first: setAddress deliberately clears the quote, because the
      // delivery fee depends on distance. Quoting before choosing an address
      // would leave a stale total on screen.
      flow.checkout.setAddress(const Address(
        id: 'a1', label: 'Home', position: LatLng(5.556, -0.1821)));
      await flow.refreshQuote();
      // Cash is only selectable AFTER the quote says it is eligible —
      // setMethod(cash) with no quote silently falls back to momo, which is
      // the controller protecting the customer from a guaranteed rejection.
      flow.checkout.setMethod(PaymentMethod.cash);
      expect(flow.checkout.canSubmit, isTrue);

      // The FIRST attempt times out, as it routinely does on mobile data.
      transport.failWith = const _Offline();
      await flow.placeOrder();
      expect(flow.checkout.stage, CheckoutStage.failed);

      // Back to editing so canSubmit is true again for the retry.
      flow.checkout.backToEditing();

      transport.failWith = null;
      await flow.placeOrder();

      expect(transport.idempotencyKeys.length, 2);
      expect(transport.idempotencyKeys[0], transport.idempotencyKeys[1],
          reason: 'a fresh key on retry is how one tap becomes two orders');
    });

    test('momo waits for the webhook rather than confirming', () async {
      final transport = fullStubs(checkout: (201, {
        'orderId': 'o-1', 'humanRef': '#1', 'state': 'pending_payment',
        'totalPesewas': '8150', 'requiresApproval': true,
      }));
      final flow = flowWith(transport);
      flow.checkout
        ..setAddress(const Address(
          id: 'a1', label: 'Home', position: LatLng(5.556, -0.1821)))
        ..setMethod(PaymentMethod.momo)
        ..setMomoPhone('0244123456');
      await flow.refreshQuote();

      final id = await flow.placeOrder();

      expect(id, 'o-1');
      expect(flow.checkout.stage, CheckoutStage.awaitingMomo);
      expect(flow.cart.isEmpty, isFalse,
          reason: 'nothing is confirmed until the payment webhook lands');
    });

    test('confirmation polling stops when the order leaves pending_payment',
        () async {
      final transport = fullStubs();
      transport.routes['GET /api/customer/home'] = (200, {
        ..._home,
        'activeOrder': {
          'id': 'o-1', 'humanRef': '#1', 'state': 'placed',
          'service': 'food', 'totalPesewas': '8150',
        },
      });
      final flow = flowWith(transport);

      final ok = await flow.awaitConfirmation(
        'o-1', attempts: 5, sleep: (_) async {},
      );

      expect(ok, isTrue);
      expect(flow.checkout.stage, CheckoutStage.confirmed);
      expect(flow.cart.isEmpty, isTrue);
    });

    test('POLLING IS BOUNDED — an unapproved prompt does not hang forever',
        () async {
      // activeOrder stays null, as it would if the customer ignored the prompt.
      final flow = flowWith(fullStubs());

      final ok = await flow.awaitConfirmation(
        'o-1', attempts: 3, sleep: (_) async {},
      );

      expect(ok, isFalse);
      expect(flow.checkout.stage, CheckoutStage.failed);
      expect(flow.checkout.error, contains('check your orders'),
          reason: 'the customer needs a next step, not an endless spinner');
    });

    test('CHANGING THE ADDRESS INVALIDATES THE QUOTE', () async {
      final flow = flowWith(fullStubs());
      flow.checkout.setAddress(const Address(
        id: 'a1', label: 'Home', position: LatLng(5.556, -0.1821)));
      await flow.refreshQuote();
      expect(flow.checkout.quote, isNotNull);

      // Osu to Cantonments is a different distance, so the delivery fee in
      // the old quote is wrong. It must be dropped, not shown.
      flow.checkout.setAddress(const Address(
        id: 'a2', label: 'Work', position: LatLng(5.5800, -0.1750)));

      expect(flow.checkout.quote, isNull,
          reason: 'a stale fee for a different address is a wrong price');
      expect(flow.checkout.canSubmit, isFalse);

      // …and the caller must re-quote, or the button says
      // "Calculating your total…" forever. (The default method is momo, so
      // a phone number is still required before it can submit.)
      await flow.refreshQuote();
      expect(flow.checkout.quote, isNotNull);
      expect(flow.checkout.blocker, isNot('Calculating your total…'));

      flow.checkout.setMomoPhone('0244123456');
      expect(flow.checkout.canSubmit, isTrue);
    });

    test('a dropped poll does not abort the wait', () async {
      final transport = fullStubs();
      var call = 0;
      final api = BesoncApi(
        baseUrl: 'http://t', maxRetries: 0, backoff: (_) => Duration.zero,
        transport: _FlakyTransport(transport, () => (call += 1) <= 2),
      );
      final flow = CheckoutFlow(
        api: api,
        cart: CartController(),
        checkout: CheckoutController(walletBalance: const Pesewas(0)),
      );
      transport.routes['GET /api/customer/home'] = (200, {
        ..._home,
        'activeOrder': {
          'id': 'o-1', 'humanRef': '#1', 'state': 'placed',
          'service': 'food', 'totalPesewas': '8150',
        },
      });

      final ok = await flow.awaitConfirmation(
        'o-1', attempts: 6, sleep: (_) async {},
      );
      expect(ok, isTrue, reason: 'mobile data drops; the wait must survive it');
    });
  });

  group('store page', () {
    testWidgets('a failed store load is retryable', (t) async {
      final transport = fullStubs();
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');
      await pumpApp(t, deps);

      transport.failWith = const _Offline();
      await t.tap(find.text('Auntie Muni Waakye').first);
      await t.pumpAndSettle();

      expect(find.byKey(const Key('store-error')), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });
}

/// Fails the first N calls, then delegates.
class _FlakyTransport implements HttpTransport {
  _FlakyTransport(this.inner, this.shouldFail);
  final RouteTransport inner;
  final bool Function() shouldFail;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    if (shouldFail()) throw const _Offline();
    return inner.send(
      method: method, url: url, headers: headers, body: body, timeout: timeout,
    );
  }
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
