/// Menu management. PDF §11.
///
/// One job dominates this screen: marking something sold out, fast. Every
/// minute an unavailable dish stays on the menu is another order the
/// kitchen has to reject — which costs the vendor their acceptance rate
/// and the customer their dinner.
///
/// So the toggle is the primary control, it is optimistic, and it reverts
/// loudly if the server disagrees. Adding a dish is secondary and lives
/// behind a button.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../state/menu_controller.dart';

class MenuScreen extends StatelessWidget {
  const MenuScreen({
    super.key,
    required this.controller,
    this.onAddItem,
  });

  final VendorMenuController controller;
  final VoidCallback? onAddItem;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        return Scaffold(
          backgroundColor: BesoncColors.canvas,
          appBar: AppBar(
            title: const Text('Menu'),
            actions: [
              IconButton(
                key: const Key('menu-refresh'),
                icon: const Icon(Icons.refresh),
                onPressed: controller.load,
              ),
            ],
          ),
          body: switch (controller.state) {
            MenuLoad.loading => const Center(
                key: Key('menu-loading'),
                child: CircularProgressIndicator(),
              ),
            MenuLoad.failed => BesoncEmpty(
                key: const Key('menu-error'),
                icon: Icons.wifi_off,
                title: 'Cannot load your menu',
                message: controller.error,
                onRetry: controller.load,
              ),
            MenuLoad.ready => _MenuBody(controller: controller),
          },
          floatingActionButton: controller.state == MenuLoad.ready
              ? FloatingActionButton.extended(
                  key: const Key('menu-add'),
                  onPressed: onAddItem,
                  icon: const Icon(Icons.add),
                  label: const Text('Add dish'),
                )
              : null,
        );
      },
    );
  }
}

class _MenuBody extends StatelessWidget {
  const _MenuBody({required this.controller});

  final VendorMenuController controller;

  @override
  Widget build(BuildContext context) {
    if (controller.items.isEmpty) {
      return const BesoncEmpty(
        key: Key('menu-empty'),
        icon: Icons.restaurant_menu,
        title: 'Your menu is empty',
        message: 'Add your first dish and customers can start ordering.',
      );
    }

    final unavailable = controller.items.where((i) => !i.isAvailable).length;

    return Column(
      children: [
        if (unavailable > 0)
          Padding(
            padding: const EdgeInsets.all(BesoncSpace.md),
            child: BesoncNotice(
              key: const Key('sold-out-banner'),
              // Stated plainly and at the top: a vendor who forgot to switch
              // the tilapia back on after a delivery loses sales silently.
              message: '$unavailable item${unavailable == 1 ? '' : 's'} '
                  'hidden from customers',
              tone: BesoncTone.warning,
            ),
          ),
        if (controller.error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.md),
            child: BesoncNotice(
              key: const Key('menu-action-error'),
              message: controller.error!,
              tone: BesoncTone.danger,
            ),
          ),
        Expanded(
          child: ListView.builder(
            itemCount: controller.items.length,
            itemBuilder: (context, i) {
              final item = controller.items[i];
              return _MenuRow(
                key: Key('menu-row-${item.id}'),
                item: item,
                pending: controller.isPending(item.id),
                onToggle: (v) => controller.setAvailability(item.id, v),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({
    super.key,
    required this.item,
    required this.pending,
    required this.onToggle,
  });

  final MenuItemView item;
  final bool pending;
  final void Function(bool) onToggle;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.symmetric(
        horizontal: BesoncSpace.lg, vertical: BesoncSpace.sm,
      ),
      margin: const EdgeInsets.only(bottom: 1),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.name,
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 15,
                    // Greyed when hidden, so a glance down the list shows
                    // what customers cannot currently order.
                    color: item.isAvailable ? null : BesoncColors.inkMuted,
                  ),
                ),
                const SizedBox(height: 2),
                // Wrap, not Row: a long dish name plus the price plus the
                // SOLD OUT badge overflows a 360dp phone by ~8px, and the
                // sold-out items are exactly the ones with long names
                // ("Grilled Tilapia with Banku and Pepper Sauce").
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: BesoncSpace.sm,
                  runSpacing: 2,
                  children: [
                    BesoncAmount(item.price.display),
                    if (!item.isAvailable)
                      const BesoncBadge('SOLD OUT', tone: BesoncTone.warning),
                  ],
                ),
              ],
            ),
          ),
          if (pending)
            const SizedBox(
              key: Key('toggle-pending'),
              width: 40, height: 40,
              child: Center(
                child: SizedBox(
                  width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else
            Switch(
              key: Key('toggle-${item.id}'),
              value: item.isAvailable,
              onChanged: onToggle,
            ),
        ],
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

/// Add one dish. Deliberately minimal — name and price is enough to start
/// selling, and a long form is a reason not to bother.
class AddItemSheet extends StatefulWidget {
  const AddItemSheet({super.key, required this.controller});

  final VendorMenuController controller;

  static Future<void> show(BuildContext context, VendorMenuController controller) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (_) => AddItemSheet(controller: controller),
      );

  @override
  State<AddItemSheet> createState() => _AddItemSheetState();
}

class _AddItemSheetState extends State<AddItemSheet> {
  final _name = TextEditingController();
  final _price = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _price.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: BesoncSpace.lg,
        right: BesoncSpace.lg,
        top: BesoncSpace.lg,
        bottom: MediaQuery.of(context).viewInsets.bottom + BesoncSpace.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Add a dish',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: BesoncSpace.lg),
          TextField(
            key: const Key('new-item-name'),
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          const SizedBox(height: BesoncSpace.md),
          TextField(
            key: const Key('new-item-price'),
            controller: _price,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[\d.]')),
            ],
            decoration: const InputDecoration(
              labelText: 'Price',
              prefixText: 'GHS ',
              // Vendors think in cedis; the app converts to pesewas. Asking
              // for "3500" would eventually get someone charging GHS 3,500.
              helperText: 'e.g. 35.00',
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: BesoncSpace.md),
            BesoncNotice(
              key: const Key('add-item-error'),
              message: _error!,
              tone: BesoncTone.danger,
            ),
          ],
          const SizedBox(height: BesoncSpace.lg),
          BesoncButton(
            key: const Key('save-item'),
            label: 'Add to menu',
            busy: _busy,
            onPressed: _save,
          ),
        ],
      ),
    );
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final pesewas = parseCedis(_price.text);

    if (name.isEmpty) {
      setState(() => _error = 'Give the dish a name');
      return;
    }
    if (pesewas == null || pesewas <= 0) {
      setState(() => _error = 'Enter a price, for example 35.00');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    final ok = await widget.controller.addItem(name: name, pricePesewas: pesewas);
    if (!mounted) return;

    if (ok) {
      Navigator.of(context).pop();
    } else {
      setState(() {
        _busy = false;
        _error = widget.controller.error ?? 'Could not add the dish';
      });
    }
  }
}

/// "35.50" -> 3550 pesewas. Null when it is not a price.
///
/// Rounds rather than truncates: 35.999 typed in a hurry should be GHS
/// 36.00, not GHS 35.99.
int? parseCedis(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return null;
  final value = double.tryParse(text);
  if (value == null || value.isNaN || value.isInfinite) return null;
  if (value < 0) return null;
  return (value * 100).round();
}
