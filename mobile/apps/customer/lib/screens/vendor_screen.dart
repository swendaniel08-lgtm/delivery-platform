/// Vendor detail and the item configuration sheet. PDF §2, §13.
///
/// This is where the customer actually spends money, so two things matter
/// most: the running total is always visible while configuring, and the
/// "Add to cart" button is disabled with a *reason* rather than silently
/// rejecting the tap.
library;

import 'package:flutter/material.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';
import '../state/cart_controller.dart';

class MenuItem {
  const MenuItem({
    required this.id,
    required this.name,
    required this.price,
    required this.available,
    this.description,
    this.imageUrl,
    this.addonGroups = const [],
  });

  final String id;
  final String name;
  final Pesewas price;
  final bool available;
  final String? description;
  final String? imageUrl;
  final List<AddonGroup> addonGroups;

  factory MenuItem.fromJson(Map<String, dynamic> j) => MenuItem(
        id: j['id'] as String,
        name: j['name'] as String,
        price: Pesewas.parse(j['basePricePesewas'] as String? ?? '0'),
        available: j['available'] as bool? ?? true,
        description: j['description'] as String?,
        imageUrl: j['imageUrl'] as String?,
        addonGroups: (j['addonGroups'] as List<dynamic>? ?? [])
            .map((g) => AddonGroup.fromJson(g as Map<String, dynamic>))
            .toList(),
      );
}

class MenuCategory {
  const MenuCategory({required this.name, required this.items});
  final String name;
  final List<MenuItem> items;

  factory MenuCategory.fromJson(Map<String, dynamic> j) => MenuCategory(
        name: j['name'] as String,
        items: (j['items'] as List<dynamic>? ?? [])
            .map((i) => MenuItem.fromJson(i as Map<String, dynamic>))
            .toList(),
      );
}

/* ------------------------------------------------------------------ */
/* Vendor screen                                                       */
/* ------------------------------------------------------------------ */

class VendorScreen extends StatelessWidget {
  const VendorScreen({
    super.key,
    required this.store,
    required this.categories,
    required this.cart,
    this.onConfigureItem,
    this.onViewCart,
  });

  final StoreCard store;
  final List<MenuCategory> categories;
  final CartController cart;
  final void Function(MenuItem)? onConfigureItem;
  final VoidCallback? onViewCart;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      appBar: AppBar(title: Text(store.name)),
      body: ListView(
        padding: EdgeInsets.zero,
        children: [
          BesoncImage(
            url: store.imageUrl, fallbackLabel: store.name, height: 160,
          ),
          Container(
            color: BesoncColors.surface,
            padding: const EdgeInsets.all(BesoncSpace.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(store.name,
                    style: const TextStyle(
                        fontSize: 20, fontWeight: FontWeight.w700)),
                const SizedBox(height: BesoncSpace.xs),
                Row(
                  children: [
                    const Icon(Icons.star, size: 15, color: BesoncColors.warning),
                    const SizedBox(width: 4),
                    Text(store.rating.toStringAsFixed(1)),
                    const Text('  ·  ', style: TextStyle(color: BesoncColors.inkMuted)),
                    Text(store.prepEstimate,
                        style: const TextStyle(color: BesoncColors.inkMuted)),
                    const Text('  ·  ', style: TextStyle(color: BesoncColors.inkMuted)),
                    Flexible(
                      child: Text('${store.deliveryFee} delivery',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: BesoncColors.inkMuted)),
                    ),
                  ],
                ),
                if (!store.isOpen) ...[
                  const SizedBox(height: BesoncSpace.md),
                  BesoncNotice(
                    key: const Key('vendor-closed'),
                    message: store.opensAt == null
                        ? 'This vendor is closed right now.'
                        : 'Closed — opens at ${store.opensAt}.',
                    tone: BesoncTone.warning,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: BesoncSpace.md),
          for (final category in categories) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(BesoncSpace.lg, BesoncSpace.lg,
                  BesoncSpace.lg, BesoncSpace.sm),
              child: Text(category.name,
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w700)),
            ),
            Container(
              color: BesoncColors.surface,
              child: Column(
                children: [
                  for (final item in category.items)
                    _MenuRow(
                      item: item,
                      enabled: store.isOpen && item.available,
                      onTap: () => onConfigureItem?.call(item),
                    ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 96),
        ],
      ),
      bottomNavigationBar: cart.isEmpty
          ? null
          : _CartBar(cart: cart, onViewCart: onViewCart),
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.item, required this.enabled, this.onTap});
  final MenuItem item;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: InkWell(
        key: Key('menu-item-${item.id}'),
        onTap: enabled ? onTap : null,
        child: Container(
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.all(BesoncSpace.lg),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: BesoncColors.line)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item.name,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w600)),
                    if (item.description != null) ...[
                      const SizedBox(height: 2),
                      Text(item.description!,
                          maxLines: 2, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontSize: 13, color: BesoncColors.inkMuted)),
                    ],
                    const SizedBox(height: BesoncSpace.sm),
                    if (!item.available)
                      const BesoncBadge('Out of stock', tone: BesoncTone.danger)
                    else
                      BesoncAmount(item.price.display),
                  ],
                ),
              ),
              const SizedBox(width: BesoncSpace.md),
              ClipRRect(
                borderRadius: BorderRadius.circular(BesoncRadius.md),
                child: BesoncImage(
                  url: item.imageUrl, fallbackLabel: item.name,
                  height: 64, width: 64,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CartBar extends StatelessWidget {
  const _CartBar({required this.cart, this.onViewCart});
  final CartController cart;
  final VoidCallback? onViewCart;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(BesoncSpace.lg),
        child: BesoncButton(
          key: const Key('view-cart'),
          label: '${cart.itemCount} item${cart.itemCount == 1 ? '' : 's'}'
              '  ·  ${cart.subtotal.display}',
          icon: Icons.shopping_basket_outlined,
          onPressed: onViewCart,
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Item configuration sheet                                            */
/* ------------------------------------------------------------------ */

class ItemSheet extends StatefulWidget {
  const ItemSheet({
    super.key,
    required this.item,
    required this.storeId,
    required this.storeName,
    this.onAdd,
  });

  final MenuItem item;
  final String storeId;
  final String storeName;
  final void Function(CartItemDraft)? onAdd;

  @override
  State<ItemSheet> createState() => _ItemSheetState();
}

class _ItemSheetState extends State<ItemSheet> {
  late final ItemConfiguration _config = ItemConfiguration(
    itemId: widget.item.id,
    name: widget.item.name,
    basePrice: widget.item.price,
    storeId: widget.storeId,
    storeName: widget.storeName,
    addonGroups: widget.item.addonGroups,
  );

  @override
  void dispose() {
    _config.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _config,
      builder: (context, _) {
        final error = _config.validationError;
        return Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(context).viewInsets.bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.all(BesoncSpace.lg),
                  children: [
                    Text(widget.item.name,
                        style: const TextStyle(
                            fontSize: 19, fontWeight: FontWeight.w700)),
                    if (widget.item.description != null) ...[
                      const SizedBox(height: BesoncSpace.xs),
                      Text(widget.item.description!,
                          style: const TextStyle(color: BesoncColors.inkMuted)),
                    ],
                    const SizedBox(height: BesoncSpace.lg),
                    for (final group in widget.item.addonGroups)
                      _AddonGroupSection(
                        group: group,
                        config: _config,
                      ),
                    const SizedBox(height: BesoncSpace.lg),
                    _QuantityRow(config: _config),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.all(BesoncSpace.lg),
                decoration: const BoxDecoration(
                  color: BesoncColors.surface,
                  border: Border(top: BorderSide(color: BesoncColors.line)),
                ),
                child: SafeArea(
                  top: false,
                  child: Column(
                    children: [
                      // The reason is always visible — never a dead button
                      // with no explanation.
                      if (error != null) ...[
                        BesoncNotice(
                          key: const Key('item-validation'),
                          message: error,
                          tone: BesoncTone.warning,
                        ),
                        const SizedBox(height: BesoncSpace.md),
                      ],
                      BesoncButton(
                        key: const Key('add-to-cart'),
                        label: 'Add to cart  ·  ${_config.lineTotal.display}',
                        onPressed: _config.canAdd
                            ? () => widget.onAdd?.call(_config.toDraft())
                            : null,
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _AddonGroupSection extends StatelessWidget {
  const _AddonGroupSection({required this.group, required this.config});
  final AddonGroup group;
  final ItemConfiguration config;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(group.name,
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(width: BesoncSpace.sm),
            if (group.required_)
              const BesoncBadge('Required', tone: BesoncTone.danger)
            else
              const BesoncBadge('Optional'),
          ],
        ),
        Text(
          group.maxSelections == 1
              ? 'Choose 1'
              : 'Choose up to ${group.maxSelections}',
          style: const TextStyle(fontSize: 12, color: BesoncColors.inkMuted),
        ),
        const SizedBox(height: BesoncSpace.sm),
        for (final option in group.options)
          _OptionRow(group: group, option: option, config: config),
        const SizedBox(height: BesoncSpace.lg),
      ],
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.group, required this.option, required this.config,
  });
  final AddonGroup group;
  final AddonOption option;
  final ItemConfiguration config;

  @override
  Widget build(BuildContext context) {
    final selected = config.isSelected(option.id);
    return Opacity(
      opacity: option.available ? 1 : 0.4,
      child: InkWell(
        key: Key('addon-${option.id}'),
        onTap: option.available ? () => config.toggle(group, option.id) : null,
        child: Container(
          constraints: const BoxConstraints(minHeight: kMinTap),
          padding: const EdgeInsets.symmetric(vertical: BesoncSpace.sm),
          child: Row(
            children: [
              Icon(
                group.maxSelections == 1
                    ? (selected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_unchecked)
                    : (selected
                        ? Icons.check_box
                        : Icons.check_box_outline_blank),
                color: selected ? BesoncColors.brand : BesoncColors.inkMuted,
                size: 22,
              ),
              const SizedBox(width: BesoncSpace.md),
              Expanded(child: Text(option.name)),
              if (!option.available)
                const BesoncBadge('Out of stock', tone: BesoncTone.danger)
              else if (option.price.value > 0)
                Text('+${option.price.display}',
                    style: const TextStyle(
                        fontSize: 13.5, color: BesoncColors.inkMuted)),
            ],
          ),
        ),
      ),
    );
  }
}

class _QuantityRow extends StatelessWidget {
  const _QuantityRow({required this.config});
  final ItemConfiguration config;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Text('Quantity',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const Spacer(),
        IconButton(
          key: const Key('qty-minus'),
          onPressed: config.quantity > 1
              ? () => config.setQuantity(config.quantity - 1)
              : null,
          icon: const Icon(Icons.remove_circle_outline),
          iconSize: 30,
        ),
        SizedBox(
          width: 40,
          child: Text('${config.quantity}',
              key: const Key('qty-value'),
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
        ),
        IconButton(
          key: const Key('qty-plus'),
          onPressed: () => config.setQuantity(config.quantity + 1),
          icon: const Icon(Icons.add_circle_outline),
          iconSize: 30,
        ),
      ],
    );
  }
}
