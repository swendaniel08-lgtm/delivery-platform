/// Checkout. PDF §6, §7.
///
/// The screen where money moves, so it is deliberately conservative:
///
///   • Every amount comes from the SERVER's quote. Nothing is added up on
///     the device — a client that computes its own total will eventually
///     disagree with the ledger, and the ledger is right.
///   • An unavailable payment method is shown, disabled, WITH THE REASON.
///     Hiding "Cash on delivery" leaves the customer wondering; saying
///     "Cash isn't available above GHS 200" answers them.
///   • Mobile money is asynchronous. The button does not celebrate on the
///     HTTP 201 — it waits for the webhook, because the customer still has
///     to approve a prompt on their handset.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../state/checkout_controller.dart';

class CheckoutScreen extends StatelessWidget {
  const CheckoutScreen({
    super.key,
    required this.controller,
    this.onPlaceOrder,
    this.onChangeAddress,
    this.onDone,
    this.onRetry,
  });

  final CheckoutController controller;
  final VoidCallback? onPlaceOrder;
  final VoidCallback? onChangeAddress;

  /// Called from the confirmed screen — usually routes to tracking.
  final VoidCallback? onDone;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) => switch (controller.stage) {
        CheckoutStage.confirmed => _Confirmed(onDone: onDone),
        CheckoutStage.awaitingMomo => _AwaitingMomo(
            phone: controller.momoPhone ?? '',
            onCancel: controller.backToEditing,
          ),
        _ => _CheckoutForm(
            controller: controller,
            onPlaceOrder: onPlaceOrder,
            onChangeAddress: onChangeAddress,
            onRetry: onRetry,
          ),
      },
    );
  }
}

/* ------------------------------------------------------------------ */

class _CheckoutForm extends StatelessWidget {
  const _CheckoutForm({
    required this.controller,
    this.onPlaceOrder,
    this.onChangeAddress,
    this.onRetry,
  });

  final CheckoutController controller;
  final VoidCallback? onPlaceOrder;
  final VoidCallback? onChangeAddress;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final quote = controller.quote;

    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      appBar: AppBar(title: const Text('Checkout')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: BesoncSpace.xxl),
        children: [
          _AddressCard(
            address: controller.address,
            onChange: onChangeAddress,
          ),
          const SizedBox(height: BesoncSpace.md),

          // The breakdown sits ABOVE the payment options deliberately. On a
          // 360x740 phone anything after the four payment rows falls below
          // the fold, and a customer should never have to scroll to find
          // what they are about to be charged.
          if (quote == null)
            const Padding(
              padding: EdgeInsets.all(BesoncSpace.lg),
              child: Column(
                key: Key('quote-loading'),
                children: [
                  BesoncSkeleton(height: 18),
                  SizedBox(height: BesoncSpace.sm),
                  BesoncSkeleton(height: 18),
                  SizedBox(height: BesoncSpace.sm),
                  BesoncSkeleton(height: 24, width: 160),
                ],
              ),
            )
          else
            _QuotePanel(quote: quote),
          const SizedBox(height: BesoncSpace.md),

          _Section(
            title: 'Payment',
            child: Column(
              children: [
                for (final method in PaymentMethod.values)
                  _PaymentTile(
                    key: Key('pay-${method.name}'),
                    method: method,
                    selected: controller.method == method,
                    enabled: controller.isMethodAvailable(method),
                    reason: controller.unavailableReason(method),
                    onTap: () => controller.setMethod(method),
                  ),
              ],
            ),
          ),

          if (controller.method == PaymentMethod.momo) ...[
            const SizedBox(height: BesoncSpace.md),
            _MomoField(
              value: controller.momoPhone,
              onChanged: controller.setMomoPhone,
            ),
          ],


          if (controller.error != null) ...[
            const SizedBox(height: BesoncSpace.md),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.md),
              child: BesoncNotice(
                key: const Key('checkout-error'),
                message: controller.error!,
                tone: BesoncTone.danger,
                actionLabel: onRetry == null ? null : 'Try again',
                onAction: onRetry,
              ),
            ),
          ],
        ],
      ),
      bottomNavigationBar: _PlaceOrderBar(
        controller: controller,
        onPlaceOrder: onPlaceOrder,
      ),
    );
  }
}

class _AddressCard extends StatelessWidget {
  const _AddressCard({this.address, this.onChange});

  final Address? address;
  final VoidCallback? onChange;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Row(
        children: [
          const Icon(Icons.location_on_outlined, color: BesoncColors.brandDark),
          const SizedBox(width: BesoncSpace.md),
          Expanded(
            child: address == null
                ? const Text(
                    'Choose a delivery address',
                    key: Key('no-address'),
                    style: TextStyle(color: BesoncColors.danger),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        address!.label,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      // The landmark is what the rider actually navigates by
                      // (PDF §5), so it gets its own line rather than being
                      // buried in a single-line summary.
                      if (address!.landmark != null)
                        Text(
                          address!.landmark!,
                          key: const Key('address-landmark'),
                          style: const TextStyle(
                            color: BesoncColors.inkMuted, fontSize: 13,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
          ),
          TextButton(
            key: const Key('change-address'),
            onPressed: onChange,
            child: const Text('Change'),
          ),
        ],
      ),
    );
  }
}

class _PaymentTile extends StatelessWidget {
  const _PaymentTile({
    super.key,
    required this.method,
    required this.selected,
    required this.enabled,
    required this.onTap,
    this.reason,
  });

  final PaymentMethod method;
  final bool selected;
  final bool enabled;
  final String? reason;
  final VoidCallback onTap;

  IconData get _icon => switch (method) {
        PaymentMethod.momo => Icons.smartphone,
        PaymentMethod.card => Icons.credit_card,
        PaymentMethod.cash => Icons.payments_outlined,
        PaymentMethod.wallet => Icons.account_balance_wallet_outlined,
      };

  @override
  Widget build(BuildContext context) {
    return ListTile(
      enabled: enabled,
      selected: selected,
      onTap: enabled ? onTap : null,
      leading: Icon(
        _icon,
        color: enabled ? (selected ? BesoncColors.brandDark : null)
                       : BesoncColors.inkMuted,
      ),
      title: Text(
        method.label,
        style: TextStyle(
          fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
          color: enabled ? null : BesoncColors.inkMuted,
        ),
      ),
      // The REASON, not just a disabled row. "Cash isn't available above
      // GHS 200" stops a support call that "greyed out" would cause.
      subtitle: reason == null
          ? null
          : Text(
              reason!,
              key: Key('reason-${method.name}'),
              style: const TextStyle(fontSize: 12.5, color: BesoncColors.inkMuted),
            ),
      trailing: selected
          ? const Icon(Icons.check_circle, color: BesoncColors.brandDark)
          : null,
    );
  }
}

class _MomoField extends StatefulWidget {
  const _MomoField({this.value, required this.onChanged});

  final String? value;
  final void Function(String) onChanged;

  @override
  State<_MomoField> createState() => _MomoFieldState();
}

class _MomoFieldState extends State<_MomoField> {
  late final TextEditingController _c =
      TextEditingController(text: widget.value ?? '');

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Mobile money number',
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          BesoncSpace.lg, 0, BesoncSpace.lg, BesoncSpace.lg,
        ),
        child: TextField(
          key: const Key('momo-phone'),
          controller: _c,
          keyboardType: TextInputType.phone,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[\d +]')),
            LengthLimitingTextInputFormatter(17),
          ],
          decoration: const InputDecoration(
            hintText: '024 412 3456',
            helperText: 'You will approve a prompt on this phone',
            prefixIcon: Icon(Icons.smartphone),
          ),
          onChanged: widget.onChanged,
        ),
      ),
    );
  }
}

class _QuotePanel extends StatelessWidget {
  const _QuotePanel({required this.quote});

  final CheckoutQuote quote;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Column(
        children: [
          _row('Items', quote.itemTotal.display, key: 'quote-items'),
          const SizedBox(height: BesoncSpace.sm),
          _row('Delivery', quote.deliveryFee.display, key: 'quote-delivery'),
          const SizedBox(height: BesoncSpace.sm),
          _row('Service fee', quote.serviceFee.display, key: 'quote-service'),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: BesoncSpace.md),
            child: Divider(height: 1),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Total',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
              BesoncAmount(
                quote.total.display,
                key: const Key('quote-total'),
                large: true,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _row(String label, String value, {required String key}) => Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: BesoncColors.inkMuted)),
          Text(value, key: Key(key)),
        ],
      );
}

class _PlaceOrderBar extends StatelessWidget {
  const _PlaceOrderBar({required this.controller, this.onPlaceOrder});

  final CheckoutController controller;
  final VoidCallback? onPlaceOrder;

  @override
  Widget build(BuildContext context) {
    final blocker = controller.blocker;

    return SafeArea(
      child: Container(
        padding: const EdgeInsets.all(BesoncSpace.md),
        decoration: const BoxDecoration(
          color: BesoncColors.surface,
          border: Border(top: BorderSide(color: BesoncColors.line)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // The button is disabled WITH a reason above it. A dead button
            // and no explanation is the most common complaint about
            // checkout screens.
            if (blocker != null) ...[
              Text(
                blocker,
                key: const Key('checkout-blocker'),
                textAlign: TextAlign.center,
                style: const TextStyle(color: BesoncColors.inkMuted, fontSize: 13),
              ),
              const SizedBox(height: BesoncSpace.sm),
            ],
            BesoncButton(
              key: const Key('place-order'),
              label: controller.quote == null
                  ? 'Place order'
                  : 'Place order · ${controller.quote!.total.display}',
              busy: controller.busy,
              onPressed: controller.canSubmit ? onPlaceOrder : null,
            ),
          ],
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

/// Mobile money is asynchronous. This screen exists because the HTTP 201
/// means "we asked Paystack", not "the customer paid".
class _AwaitingMomo extends StatelessWidget {
  const _AwaitingMomo({required this.phone, this.onCancel});

  final String phone;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('awaiting-momo'),
      backgroundColor: BesoncColors.canvas,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(BesoncSpace.xl),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.smartphone, size: 56, color: BesoncColors.brandDark),
              const SizedBox(height: BesoncSpace.lg),
              const Text(
                'Check your phone',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: BesoncSpace.sm),
              Text(
                'Approve the mobile money prompt on $phone to confirm your order.',
                textAlign: TextAlign.center,
                style: const TextStyle(color: BesoncColors.inkMuted),
              ),
              const SizedBox(height: BesoncSpace.xl),
              const CircularProgressIndicator(),
              const SizedBox(height: BesoncSpace.xl),
              const Text(
                'Do not close the app. This usually takes a few seconds.',
                textAlign: TextAlign.center,
                style: TextStyle(color: BesoncColors.inkMuted, fontSize: 12.5),
              ),
              const SizedBox(height: BesoncSpace.lg),
              TextButton(
                key: const Key('momo-cancel'),
                onPressed: onCancel,
                child: const Text('Cancel and change payment'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Confirmed extends StatelessWidget {
  const _Confirmed({this.onDone});

  final VoidCallback? onDone;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('checkout-confirmed'),
      backgroundColor: BesoncColors.canvas,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(BesoncSpace.xl),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.check_circle, size: 64, color: BesoncColors.success),
              const SizedBox(height: BesoncSpace.lg),
              const Text(
                'Order placed',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: BesoncSpace.sm),
              const Text(
                'The vendor is confirming your order now.',
                textAlign: TextAlign.center,
                style: TextStyle(color: BesoncColors.inkMuted),
              ),
              const SizedBox(height: BesoncSpace.xl),
              BesoncButton(
                key: const Key('track-order'),
                label: 'Track my order',
                onPressed: onDone,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      width: double.infinity,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              BesoncSpace.lg, BesoncSpace.lg, BesoncSpace.lg, BesoncSpace.sm,
            ),
            child: Text(
              title,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
            ),
          ),
          child,
        ],
      ),
    );
  }
}
