/// Cart and checkout screens.
///
/// Everything runs at 360x740 — the commonest Android size in Ghana, and
/// the width at which layout bugs actually appear. The 800x600 test default
/// hides them.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_customer/screens/cart_screen.dart';
import 'package:besonc_customer/screens/checkout_screen.dart';
import 'package:besonc_customer/state/cart_controller.dart';
import 'package:besonc_customer/state/checkout_controller.dart';

CartItemDraft jollof({
  int quantity = 1,
  Set<String>? addons,
  String? note,
  String name = 'Jollof Rice',
}) =>
    CartItemDraft(
      itemId: 'i1',
      name: name,
      basePrice: const Pesewas(3500),
      storeId: 's1',
      storeName: 'Auntie Muni Waakye',
      quantity: quantity,
      addonIds: addons ?? {'a1'},
      addonTotal: const Pesewas(1500),
      note: note,
    );

/// Scroll the checkout list until [finder] is on screen.
///
/// Checkout is genuinely taller than a 360x740 phone, so a real customer
/// scrolls to reach the payment options. A test that asserts without
/// scrolling is testing the viewport, not the screen.
Future<void> scrollTo(WidgetTester t, Finder finder) async {
  await t.scrollUntilVisible(
    finder, 120,
    scrollable: find.byType(Scrollable).first,
  );
  await t.pump();
}

/// True if Flutter reported a layout overflow during the last pump.
bool overflowed(WidgetTester t) {
  final e = t.takeException();
  return e != null && e.toString().contains('overflowed');
}

void main() {
  Future<void> pump(WidgetTester t, Widget child) async {
    await t.binding.setSurfaceSize(const Size(360, 740));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(MaterialApp(home: child));
    await t.pump();
  }

  group('empty cart', () {
    testWidgets('offers a way back to browsing', (t) async {
      var browsed = false;
      await pump(t, CartScreen(cart: CartController(), onBrowse: () => browsed = true));

      expect(find.byKey(const Key('cart-empty')), findsOneWidget);
      expect(find.text('Your cart is empty'), findsOneWidget);

      await t.tap(find.text('Try again'));
      expect(browsed, isTrue, reason: 'a dead end is the worst empty state');
    });

    testWidgets('shows no checkout button with nothing to buy', (t) async {
      await pump(t, CartScreen(cart: CartController()));
      expect(find.byKey(const Key('cart-checkout')), findsNothing);
    });
  });

  group('cart with items', () {
    testWidgets('renders the line, the store and the subtotal', (t) async {
      final cart = CartController()..add(jollof(quantity: 2));
      await pump(t, CartScreen(cart: cart));

      expect(find.text('Auntie Muni Waakye'), findsOneWidget);
      expect(find.text('Jollof Rice'), findsOneWidget);
      // 3500 base + 1500 addon = 5000 each, x2.
      expect(find.text('GHS 100.00'), findsWidgets);
      expect(find.byKey(const Key('cart-count')), findsOneWidget);
      expect(find.text('2 items'), findsOneWidget);
    });

    testWidgets('SUBTOTAL, never "total" — fees come later', (t) async {
      final cart = CartController()..add(jollof());
      await pump(t, CartScreen(cart: cart));

      expect(find.text('Subtotal'), findsOneWidget);
      expect(find.textContaining('added at checkout'), findsOneWidget,
          reason: 'a total that grows at the next screen reads as a swindle');
    });

    testWidgets('the stepper increments and the subtotal follows', (t) async {
      final cart = CartController()..add(jollof());
      await pump(t, CartScreen(cart: cart));

      await t.tap(find.byKey(const Key('line-increment')));
      await t.pump();

      expect(cart.itemCount, 2);
      expect(find.text('GHS 100.00'), findsWidgets);
    });

    testWidgets('at quantity one the minus becomes a delete', (t) async {
      final cart = CartController()..add(jollof());
      await pump(t, CartScreen(cart: cart));

      expect(find.byIcon(Icons.delete_outline), findsOneWidget);
      expect(find.byIcon(Icons.remove), findsNothing,
          reason: 'decrementing to zero would leave a meaningless empty line');
    });

    testWidgets('above one it is a normal decrement', (t) async {
      final cart = CartController()..add(jollof(quantity: 3));
      await pump(t, CartScreen(cart: cart));

      expect(find.byIcon(Icons.remove), findsOneWidget);
      await t.tap(find.byKey(const Key('line-decrement')));
      await t.pump();
      expect(cart.itemCount, 2);
    });

    testWidgets('REMOVAL IS UNDOABLE', (t) async {
      final cart = CartController()..add(jollof(quantity: 2));
      await pump(t, CartScreen(cart: cart));

      await t.tap(find.byKey(const Key('line-decrement')));   // delete at qty 2? no
      await t.pump();
      expect(cart.itemCount, 1);

      await t.tap(find.byKey(const Key('line-decrement')));   // now a delete
      await t.pumpAndSettle();
      expect(cart.isEmpty, isTrue);

      expect(find.text('Undo'), findsOneWidget);
      await t.tap(find.text('Undo'));
      await t.pump();

      expect(cart.isEmpty, isFalse, reason: 'a fat finger must be recoverable');
      expect(cart.lines.single.quantity, 1);
    });

    testWidgets('increment stops at the server limit', (t) async {
      final cart = CartController()..add(jollof(quantity: kMaxLineQuantity));
      await pump(t, CartScreen(cart: cart));

      final button = t.widget<IconButton>(find.byKey(const Key('line-increment')));
      expect(button.onPressed, isNull,
          reason: 'better a disabled button than a 422 from the server');
    });

    testWidgets('a customer note is shown to confirm it was recorded', (t) async {
      final cart = CartController()..add(jollof(note: 'no pepper please'));
      await pump(t, CartScreen(cart: cart));
      expect(find.textContaining('no pepper please'), findsOneWidget);
    });

    testWidgets('a closed vendor is flagged without blocking the cart', (t) async {
      final cart = CartController()..add(jollof());
      await pump(t, CartScreen(cart: cart, storeIsOpen: false));

      expect(find.byKey(const Key('cart-store-closed')), findsOneWidget);
      expect(find.byKey(const Key('cart-checkout')), findsOneWidget,
          reason: 'they can still check out when the vendor reopens');
    });

    testWidgets('lays out on a 360dp phone without overflow', (t) async {
      final cart = CartController()
        ..add(jollof(quantity: 2, note: 'extra shito and plenty salad on the side'))
        ..add(jollof(name: 'Grilled Tilapia with Banku', addons: {'a2'}));
      await pump(t, CartScreen(cart: cart));

      expect(overflowed(t), isFalse);
    });
  });

  group('one vendor per cart', () {
    testWidgets('the dialog explains the trade rather than silently swapping',
        (t) async {
      await pump(
        t,
        Builder(
          builder: (context) => TextButton(
            onPressed: () => DifferentVendorDialog.show(
              context, currentStore: 'Auntie Muni', newStore: 'Chez Clarisse',
            ),
            child: const Text('open'),
          ),
        ),
      );

      await t.tap(find.text('open'));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('different-vendor-dialog')), findsOneWidget);
      expect(find.textContaining('Auntie Muni'), findsWidgets);
      expect(find.textContaining('Chez Clarisse'), findsWidgets);
      // Both options are explicit; neither is a trap.
      expect(find.byKey(const Key('keep-cart')), findsOneWidget);
      expect(find.byKey(const Key('replace-cart')), findsOneWidget);
    });
  });

  /* ---------------------------------------------------------------- */

  group('checkout', () {
    CheckoutController ready({
      Pesewas wallet = const Pesewas(0),
      bool codEligible = false,
      String? codReason,
      PaymentMethod method = PaymentMethod.momo,
    }) {
      final c = CheckoutController(walletBalance: wallet, method: method)
        ..setAddress(const Address(
          id: 'a1', label: 'Home',
          position: LatLng(5.556, -0.1821),
          landmark: 'behind the MTN mast',
        ))
        ..setQuote(CheckoutQuote(
          itemTotal: const Pesewas(7000),
          deliveryFee: const Pesewas(800),
          serviceFee: const Pesewas(350),
          total: const Pesewas(8150),
          codEligible: codEligible,
          codReason: codReason,
        ));
      return c;
    }

    testWidgets('shows the canonical GHS 81.50 breakdown from the server',
        (t) async {
      await pump(t, CheckoutScreen(controller: ready()));

      expect(find.byKey(const Key('quote-items')), findsOneWidget);
      expect(find.text('GHS 70.00'), findsOneWidget);
      expect(find.text('GHS 8.00'), findsOneWidget);
      expect(find.text('GHS 3.50'), findsOneWidget);
      expect(find.text('GHS 81.50'), findsWidgets);
    });

    testWidgets('the landmark is shown — it is what the rider navigates by',
        (t) async {
      await pump(t, CheckoutScreen(controller: ready()));
      expect(find.byKey(const Key('address-landmark')), findsOneWidget);
      expect(find.text('behind the MTN mast'), findsOneWidget);
    });

    testWidgets('an unavailable method shows THE REASON, not just grey',
        (t) async {
      await pump(t, CheckoutScreen(
        controller: ready(codReason: 'Cash is not available above GHS 200'),
      ));

      expect(find.byKey(const Key('pay-cash')), findsOneWidget,
          reason: 'hiding it leaves the customer wondering');
      expect(find.text('Cash is not available above GHS 200'), findsOneWidget);
    });

    testWidgets('an insufficient wallet says how much is actually in it',
        (t) async {
      await pump(t, CheckoutScreen(controller: ready(wallet: const Pesewas(2000))));
      expect(find.textContaining('GHS 20.00'), findsWidgets);
      expect(find.textContaining('not enough'), findsOneWidget);
    });

    testWidgets('cash becomes selectable when the server allows it', (t) async {
      final c = ready(codEligible: true);
      await pump(t, CheckoutScreen(controller: c));

      await t.tap(find.byKey(const Key('pay-cash')));
      await t.pump();
      expect(c.method, PaymentMethod.cash);
    });

    testWidgets('the momo field only appears for mobile money', (t) async {
      final c = ready(codEligible: true);
      await pump(t, CheckoutScreen(controller: c));

      await scrollTo(t, find.byKey(const Key('momo-phone')));
      expect(find.byKey(const Key('momo-phone')), findsOneWidget);

      await t.tap(find.byKey(const Key('pay-cash')));
      await t.pump();
      expect(find.byKey(const Key('momo-phone')), findsNothing);
    });

    testWidgets('a missing momo number blocks the order with an explanation',
        (t) async {
      final c = ready();
      await pump(t, CheckoutScreen(controller: c));

      expect(c.canSubmit, isFalse);
      expect(find.byKey(const Key('checkout-blocker')), findsOneWidget);
      expect(find.textContaining('mobile money number'), findsWidgets);
    });

    testWidgets('a valid number unblocks it', (t) async {
      final c = ready();
      await pump(t, CheckoutScreen(controller: c));

      await scrollTo(t, find.byKey(const Key('momo-phone')));
      await t.enterText(find.byKey(const Key('momo-phone')), '0244123456');
      await t.pump();

      expect(c.canSubmit, isTrue);
      expect(find.byKey(const Key('checkout-blocker')), findsNothing);
    });

    testWidgets('an invalid number is rejected before any network call',
        (t) async {
      final c = ready();
      await pump(t, CheckoutScreen(controller: c));

      await scrollTo(t, find.byKey(const Key('momo-phone')));
      await t.enterText(find.byKey(const Key('momo-phone')), '12345');
      await t.pump();

      expect(c.canSubmit, isFalse);
      expect(find.textContaining('valid Ghana mobile'), findsWidgets);
    });

    testWidgets('a missing quote shows a skeleton, not a zero total', (t) async {
      final c = CheckoutController(walletBalance: const Pesewas(0))
        ..setAddress(const Address(
          id: 'a1', label: 'Home', position: LatLng(5.556, -0.1821),
        ));
      await pump(t, CheckoutScreen(controller: c));

      expect(find.byKey(const Key('quote-loading')), findsOneWidget);
      // No TOTAL is rendered at all while the quote is loading. (An empty
      // wallet legitimately reads "GHS 0.00", so assert on the total's key
      // rather than on the string anywhere on screen.)
      expect(find.byKey(const Key('quote-total')), findsNothing,
          reason: 'a zero total is a lie, however briefly it is on screen');
      expect(find.byKey(const Key('quote-items')), findsNothing);
    });

    testWidgets('MOMO WAITS FOR THE WEBHOOK instead of celebrating', (t) async {
      final c = ready()..setMomoPhone('0244123456');
      await pump(t, CheckoutScreen(controller: c));

      c.beginSubmit(() => 'key-1');
      c.awaitingMomoApproval();
      await t.pump();

      expect(find.byKey(const Key('awaiting-momo')), findsOneWidget);
      expect(find.text('Check your phone'), findsOneWidget);
      expect(find.byKey(const Key('checkout-confirmed')), findsNothing,
          reason: 'HTTP 201 means "we asked Paystack", not "the customer paid"');
    });

    testWidgets('confirmation offers tracking', (t) async {
      final c = ready()..setMomoPhone('0244123456');
      var done = false;
      await pump(t, CheckoutScreen(controller: c, onDone: () => done = true));

      c.confirmed();
      await t.pump();

      expect(find.byKey(const Key('checkout-confirmed')), findsOneWidget);
      await t.tap(find.byKey(const Key('track-order')));
      expect(done, isTrue);
    });

    testWidgets('a failure is explained and retryable', (t) async {
      final c = ready()..setMomoPhone('0244123456');
      var retried = false;
      await pump(t, CheckoutScreen(controller: c, onRetry: () => retried = true));

      c.failed('Your mobile money wallet has insufficient funds');
      await t.pump();

      await scrollTo(t, find.byKey(const Key('checkout-error')));
      expect(find.byKey(const Key('checkout-error')), findsOneWidget);
      expect(find.textContaining('insufficient funds'), findsOneWidget);

      await t.tap(find.text('Try again'));
      expect(retried, isTrue);
    });

    testWidgets('a retry reuses the SAME idempotency key', (t) async {
      final c = ready()..setMomoPhone('0244123456');
      final first = c.beginSubmit(() => 'generated-once');
      c.failed('network timeout');
      final second = c.beginSubmit(() => 'a-different-key');

      expect(second, first,
          reason: 'a new key on retry is how one tap becomes two orders');
    });

    testWidgets('checkout fits a 360dp phone', (t) async {
      await pump(t, CheckoutScreen(controller: ready(codEligible: true)));
      expect(overflowed(t), isFalse);
    });
  });
}
