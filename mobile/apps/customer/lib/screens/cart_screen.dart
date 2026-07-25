/// The cart. PDF §13.
///
/// Three things drive the design:
///
///   1. **The subtotal shown here is provisional.** Delivery and service fees
///      come from the server at checkout, so the cart says "Subtotal", never
///      "Total". Showing a total that then changes is how you get a customer
///      who feels cheated at the last screen.
///   2. **One vendor per cart** (PDF §13). Adding from a second store is
///      offered as a clear choice, never a silent replacement.
///   3. **Removal is undoable.** Fat fingers on a 360dp screen are the norm,
///      and a line vanishing with no way back is worse than a confirm dialog.
library;

import 'package:flutter/material.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../state/cart_controller.dart';

class CartScreen extends StatelessWidget {
  const CartScreen({
    super.key,
    required this.cart,
    this.onCheckout,
    this.onAddMore,
    this.onBrowse,
    this.storeIsOpen = true,
    this.closedMessage,
  });

  final CartController cart;
  final VoidCallback? onCheckout;
  final VoidCallback? onAddMore;
  final VoidCallback? onBrowse;

  /// A vendor can close while the cart sits open on the customer's phone.
  final bool storeIsOpen;
  final String? closedMessage;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: cart,
      builder: (context, _) {
        if (cart.isEmpty) {
          return Scaffold(
            backgroundColor: BesoncColors.canvas,
            appBar: AppBar(title: const Text('Your cart')),
            body: BesoncEmpty(
              key: const Key('cart-empty'),
              icon: Icons.shopping_basket_outlined,
              title: 'Your cart is empty',
              message: 'Find something to eat and it will show up here.',
              onRetry: onBrowse,
            ),
          );
        }

        return Scaffold(
          backgroundColor: BesoncColors.canvas,
          appBar: AppBar(
            title: Text(cart.storeName ?? 'Your cart'),
            // The item count is in the title bar because it is the one number
            // people check before paying.
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(20),
              child: Padding(
                padding: const EdgeInsets.only(bottom: BesoncSpace.sm),
                child: Text(
                  '${cart.itemCount} item${cart.itemCount == 1 ? '' : 's'}',
                  key: const Key('cart-count'),
                  style: const TextStyle(
                    color: BesoncColors.inkMuted, fontSize: 13,
                  ),
                ),
              ),
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.only(bottom: BesoncSpace.xxl),
            children: [
              if (!storeIsOpen)
                Padding(
                  padding: const EdgeInsets.all(BesoncSpace.md),
                  child: BesoncNotice(
                    key: const Key('cart-store-closed'),
                    message: closedMessage
                        ?? 'This vendor has closed. You can still check out '
                            'when they reopen.',
                    tone: BesoncTone.warning,
                  ),
                ),

              Container(
                color: BesoncColors.surface,
                child: Column(
                  children: [
                    for (final line in cart.lines)
                      _CartLineTile(
                        key: Key('cart-line-${line.signature}'),
                        line: line,
                        onIncrement: () => cart.increment(line.signature),
                        onDecrement: () => cart.decrement(line.signature),
                        onRemove: () => _removeWithUndo(context, line),
                      ),
                  ],
                ),
              ),

              Padding(
                padding: const EdgeInsets.all(BesoncSpace.md),
                child: OutlinedButton.icon(
                  key: const Key('cart-add-more'),
                  onPressed: onAddMore,
                  icon: const Icon(Icons.add),
                  label: const Text('Add more items'),
                ),
              ),

              const SizedBox(height: BesoncSpace.md),
              _SubtotalPanel(subtotal: cart.subtotal),
            ],
          ),
          bottomNavigationBar: _CheckoutBar(
            subtotal: cart.subtotal,
            onCheckout: onCheckout,
          ),
        );
      },
    );
  }

  /// Remove, but offer the line back for a few seconds.
  void _removeWithUndo(BuildContext context, CartItemDraft line) {
    cart.remove(line.signature);
    final messenger = ScaffoldMessenger.of(context);
    messenger.clearSnackBars();
    messenger.showSnackBar(
      SnackBar(
        content: Text('${line.name} removed'),
        action: SnackBarAction(
          label: 'Undo',
          // `add` merges by signature, so restoring the identical line puts
          // the exact quantity back rather than resetting it to one.
          onPressed: () => cart.add(line),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

class _CartLineTile extends StatelessWidget {
  const _CartLineTile({
    super.key,
    required this.line,
    required this.onIncrement,
    required this.onDecrement,
    required this.onRemove,
  });

  final CartItemDraft line;
  final VoidCallback onIncrement;
  final VoidCallback onDecrement;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final options = [...line.variantIds, ...line.addonIds];

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: BesoncSpace.lg, vertical: BesoncSpace.md,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  line.name,
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                ),
                if (options.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    '${options.length} option${options.length == 1 ? '' : 's'}',
                    style: const TextStyle(
                      color: BesoncColors.inkMuted, fontSize: 12.5,
                    ),
                  ),
                ],
                if (line.note != null && line.note!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    '“${line.note}”',
                    style: const TextStyle(
                      color: BesoncColors.inkMuted,
                      fontSize: 12.5,
                      fontStyle: FontStyle.italic,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: BesoncSpace.sm),
                BesoncAmount(line.lineTotal.display),
              ],
            ),
          ),
          const SizedBox(width: BesoncSpace.sm),
          _QuantityStepper(
            quantity: line.quantity,
            onIncrement: onIncrement,
            // At one, the minus button becomes a remove — matching what
            // people expect, and avoiding a zero-quantity line.
            onDecrement: line.quantity > 1 ? onDecrement : onRemove,
            decrementIsRemove: line.quantity == 1,
          ),
        ],
      ),
    );
  }
}

class _QuantityStepper extends StatelessWidget {
  const _QuantityStepper({
    required this.quantity,
    required this.onIncrement,
    required this.onDecrement,
    required this.decrementIsRemove,
  });

  final int quantity;
  final VoidCallback onIncrement;
  final VoidCallback onDecrement;
  final bool decrementIsRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: BesoncColors.line),
        borderRadius: BorderRadius.circular(BesoncRadius.md),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            key: const Key('line-decrement'),
            // 40dp minimum: below that, misses are constant on a phone held
            // one-handed.
            constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
            padding: EdgeInsets.zero,
            visualDensity: VisualDensity.compact,
            icon: Icon(
              decrementIsRemove ? Icons.delete_outline : Icons.remove,
              size: 18,
              color: decrementIsRemove ? BesoncColors.danger : null,
            ),
            onPressed: onDecrement,
          ),
          SizedBox(
            width: 24,
            child: Text(
              '$quantity',
              textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          IconButton(
            key: const Key('line-increment'),
            constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
            padding: EdgeInsets.zero,
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.add, size: 18),
            onPressed: quantity >= kMaxLineQuantity ? null : onIncrement,
          ),
        ],
      ),
    );
  }
}

class _SubtotalPanel extends StatelessWidget {
  const _SubtotalPanel({required this.subtotal});

  final Pesewas subtotal;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Subtotal', style: TextStyle(fontSize: 15)),
              BesoncAmount(subtotal.display, key: const Key('cart-subtotal')),
            ],
          ),
          const SizedBox(height: BesoncSpace.sm),
          const Row(
            children: [
              Icon(Icons.info_outline, size: 14, color: BesoncColors.inkMuted),
              SizedBox(width: 6),
              Expanded(
                child: Text(
                  // Deliberately explicit. A number that grows at the next
                  // screen without warning reads as a bait and switch.
                  'Delivery and service fees are added at checkout.',
                  style: TextStyle(color: BesoncColors.inkMuted, fontSize: 12.5),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CheckoutBar extends StatelessWidget {
  const _CheckoutBar({required this.subtotal, this.onCheckout});

  final Pesewas subtotal;
  final VoidCallback? onCheckout;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Container(
        padding: const EdgeInsets.all(BesoncSpace.md),
        decoration: const BoxDecoration(
          color: BesoncColors.surface,
          border: Border(top: BorderSide(color: BesoncColors.line)),
        ),
        child: BesoncButton(
          key: const Key('cart-checkout'),
          label: 'Checkout · ${subtotal.display}',
          onPressed: onCheckout,
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

/// Shown when the customer adds an item from a different vendor.
///
/// A dialog rather than a silent swap: the cart is the customer's work, and
/// throwing it away without asking is the kind of thing that gets an app
/// deleted.
class DifferentVendorDialog extends StatelessWidget {
  const DifferentVendorDialog({
    super.key,
    required this.currentStore,
    required this.newStore,
  });

  final String currentStore;
  final String newStore;

  static Future<bool> show(
    BuildContext context, {
    required String currentStore,
    required String newStore,
  }) async {
    final replace = await showDialog<bool>(
      context: context,
      builder: (_) => DifferentVendorDialog(
        currentStore: currentStore, newStore: newStore,
      ),
    );
    return replace ?? false;
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      key: const Key('different-vendor-dialog'),
      title: const Text('Start a new cart?'),
      content: Text(
        'Your cart has items from $currentStore. '
        'Besonc delivers from one vendor at a time, so adding from '
        '$newStore will empty it.',
      ),
      actions: [
        TextButton(
          key: const Key('keep-cart'),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text('Keep $currentStore'),
        ),
        FilledButton(
          key: const Key('replace-cart'),
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Start new cart'),
        ),
      ],
    );
  }
}
