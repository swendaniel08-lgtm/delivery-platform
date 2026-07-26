/// Customer home. PDF §10.
///
/// One BFF call renders everything here. The screen is built so that each
/// region fails independently: if the vendor carousels are empty because the
/// catalogue is down, the active-order banner and the service grid still work
/// — that banner is usually why the customer opened the app at all.

library;

import 'package:flutter/material.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';

/* ------------------------------------------------------------------ */
/* View model                                                          */
/* ------------------------------------------------------------------ */

class HomeData {
  const HomeData({
    required this.services,
    required this.popular,
    required this.topRated,
    this.address,
    this.activeOrder,
  });

  final Address? address;
  final List<ServiceTile> services;
  final ActiveOrder? activeOrder;
  final List<StoreCard> popular;
  final List<StoreCard> topRated;

  factory HomeData.fromJson(Map<String, dynamic> j) {
    List<StoreCard> cards(String key) => (j[key] as List<dynamic>? ?? [])
        .map((c) => StoreCard.fromJson(c as Map<String, dynamic>))
        .toList();

    final to = j['deliveringTo'] as Map<String, dynamic>?;
    final active = j['activeOrder'] as Map<String, dynamic>?;

    return HomeData(
      address: to == null
          ? null
          : Address.fromJson({
              'id': 'current', 'label': to['label'] ?? 'Delivering to',
              'lat': to['lat'], 'lng': to['lng'],
              'areaName': to['areaName'], 'landmark': to['landmark'],
            }),
      services: (j['services'] as List<dynamic>? ?? [])
          .map((s) => ServiceTile.fromJson(s as Map<String, dynamic>))
          .toList(),
      activeOrder: active == null ? null : ActiveOrder.fromJson(active),
      popular: cards('popularNearYou'),
      topRated: cards('topRated'),
    );
  }
}

enum LoadState { loading, ready, failed }

/* ------------------------------------------------------------------ */
/* Screen                                                             */
/* ------------------------------------------------------------------ */

class HomeScreen extends StatelessWidget {
  const HomeScreen({
    super.key,
    required this.state,
    this.data,
    this.errorMessage,
    this.onRetry,
    this.onChangeAddress,
    this.onOpenService,
    this.onOpenStore,
    this.onOpenActiveOrder,
    this.onSearch,
    this.onOpenHistory,
  });

  final LoadState state;
  final HomeData? data;
  final String? errorMessage;
  final VoidCallback? onRetry;
  final VoidCallback? onChangeAddress;
  final void Function(String serviceKey)? onOpenService;
  final void Function(String storeId)? onOpenStore;
  final VoidCallback? onOpenActiveOrder;
  final VoidCallback? onSearch;
  final VoidCallback? onOpenHistory;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      body: SafeArea(
        child: switch (state) {
          LoadState.loading => const _HomeSkeleton(),
          LoadState.failed => BesoncEmpty(
              key: const Key('home-error'),
              icon: Icons.wifi_off,
              title: 'Cannot reach Besonc',
              message: errorMessage ?? 'Check your connection and try again.',
              onRetry: onRetry,
            ),
          LoadState.ready => _HomeBody(
              data: data!,
              onChangeAddress: onChangeAddress,
              onOpenHistory: onOpenHistory,
              onOpenService: onOpenService,
              onOpenStore: onOpenStore,
              onOpenActiveOrder: onOpenActiveOrder,
              onSearch: onSearch,
            ),
        },
      ),
    );
  }
}

class _HomeBody extends StatelessWidget {
  const _HomeBody({
    required this.data,
    this.onChangeAddress,
    this.onOpenService,
    this.onOpenStore,
    this.onOpenActiveOrder,
    this.onSearch,
    this.onOpenHistory,
  });

  final HomeData data;
  final VoidCallback? onChangeAddress;
  final void Function(String)? onOpenService;
  final void Function(String)? onOpenStore;
  final VoidCallback? onOpenActiveOrder;
  final VoidCallback? onSearch;
  final VoidCallback? onOpenHistory;

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        SliverToBoxAdapter(
          child: _AddressBar(
            address: data.address,
            onTap: onChangeAddress,
            onOpenHistory: onOpenHistory,
          ),
        ),
        SliverToBoxAdapter(child: _SearchBar(onTap: onSearch)),

        // Sticky-feeling active order, placed above the fold deliberately.
        if (data.activeOrder != null)
          SliverToBoxAdapter(
            child: _ActiveOrderBanner(
              order: data.activeOrder!, onTap: onOpenActiveOrder,
            ),
          ),

        SliverToBoxAdapter(
          child: _ServiceGrid(services: data.services, onOpen: onOpenService),
        ),

        if (data.popular.isNotEmpty)
          SliverToBoxAdapter(
            child: _StoreCarousel(
              key: const Key('carousel-popular'),
              title: 'Popular near you',
              stores: data.popular,
              onOpenStore: onOpenStore,
            ),
          ),
        if (data.topRated.isNotEmpty)
          SliverToBoxAdapter(
            child: _StoreCarousel(
              key: const Key('carousel-top'),
              title: 'Top rated',
              stores: data.topRated,
              onOpenStore: onOpenStore,
            ),
          ),

        // Catalogue unavailable but the rest of the screen still works.
        if (data.popular.isEmpty && data.topRated.isEmpty)
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(BesoncSpace.lg),
              child: BesoncNotice(
                key: Key('no-vendors'),
                message: 'We could not load vendors right now. '
                    'Pull down to refresh.',
                tone: BesoncTone.warning,
              ),
            ),
          ),

        const SliverToBoxAdapter(child: SizedBox(height: BesoncSpace.xxl)),
      ],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

class _AddressBar extends StatelessWidget {
  const _AddressBar({this.address, this.onTap, this.onOpenHistory});
  final Address? address;
  final VoidCallback? onTap;
  final VoidCallback? onOpenHistory;

  @override
  Widget build(BuildContext context) {
    final missing = address == null;
    return InkWell(
      key: const Key('address-bar'),
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: kMinTap),
        padding: const EdgeInsets.symmetric(
          horizontal: BesoncSpace.lg, vertical: BesoncSpace.md,
        ),
        color: BesoncColors.surface,
        child: Row(
          children: [
            const Icon(Icons.location_on_outlined,
                size: 20, color: BesoncColors.brand),
            const SizedBox(width: BesoncSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    missing ? 'Set your delivery address' : 'Delivering to',
                    style: const TextStyle(
                        fontSize: 11, color: BesoncColors.inkMuted),
                  ),
                  Text(
                    missing ? 'Tap to choose' : address!.shortDisplay,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
            const Icon(Icons.keyboard_arrow_down, color: BesoncColors.inkMuted),
            // Order history lives here rather than behind a nav drawer: the
            // three reasons people open it — receipt, reorder, check a
            // charge — are all urgent enough that two taps is one too many.
            if (onOpenHistory != null)
              IconButton(
                key: const Key('open-history'),
                icon: const Icon(Icons.receipt_long_outlined, size: 22),
                color: BesoncColors.inkMuted,
                tooltip: 'Your orders',
                onPressed: onOpenHistory,
              ),
          ],
        ),
      ),
    );
  }
}

class _SearchBar extends StatelessWidget {
  const _SearchBar({this.onTap});
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          BesoncSpace.lg, BesoncSpace.md, BesoncSpace.lg, BesoncSpace.sm),
      child: InkWell(
        key: const Key('search-bar'),
        onTap: onTap,
        child: Container(
          height: kMinTap,
          padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.md),
          decoration: BoxDecoration(
            color: BesoncColors.surface,
            border: Border.all(color: BesoncColors.line),
            borderRadius: BorderRadius.circular(BesoncRadius.md),
          ),
          child: const Row(
            children: [
              Icon(Icons.search, size: 20, color: BesoncColors.inkMuted),
              SizedBox(width: BesoncSpace.sm),
              Expanded(
                child: Text(
                  'Search for food, shops, items…',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: BesoncColors.inkMuted),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActiveOrderBanner extends StatelessWidget {
  const _ActiveOrderBanner({required this.order, this.onTap});
  final ActiveOrder order;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
          horizontal: BesoncSpace.lg, vertical: BesoncSpace.sm),
      child: InkWell(
        key: const Key('active-order-banner'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(BesoncRadius.lg),
        child: Container(
          padding: const EdgeInsets.all(BesoncSpace.lg),
          decoration: BoxDecoration(
            color: BesoncColors.brandSoft,
            border: Border.all(color: BesoncColors.brand.withValues(alpha: 0.4)),
            borderRadius: BorderRadius.circular(BesoncRadius.lg),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        BesoncBadge(order.humanRef, tone: BesoncTone.brand),
                        const SizedBox(width: BesoncSpace.sm),
                        if (order.state.isTrackable)
                          const BesoncBadge('Live',
                              tone: BesoncTone.success,
                              icon: Icons.circle),
                      ],
                    ),
                    const SizedBox(height: BesoncSpace.sm),
                    Text(
                      order.bannerText,
                      style: const TextStyle(
                          fontSize: 15, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: BesoncColors.brandDark),
            ],
          ),
        ),
      ),
    );
  }
}

class _ServiceGrid extends StatelessWidget {
  const _ServiceGrid({required this.services, this.onOpen});
  final List<ServiceTile> services;
  final void Function(String)? onOpen;

  static const _icons = <String, IconData>{
    'food': Icons.restaurant,
    'groceries': Icons.local_grocery_store_outlined,
    'market': Icons.storefront_outlined,
    'shop': Icons.shopping_bag_outlined,
    'pharmacy': Icons.medical_services_outlined,
    'laundry': Icons.local_laundry_service_outlined,
    'parcel': Icons.inventory_2_outlined,
    'errand': Icons.directions_run,
  };

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: GridView.count(
        key: const Key('service-grid'),
        crossAxisCount: 4,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: BesoncSpace.md,
        crossAxisSpacing: BesoncSpace.md,
        childAspectRatio: 0.85,
        children: services.map((s) {
          // Disabled services stay VISIBLE but inert — hiding them makes the
          // app look emptier than it is and hides the roadmap from customers.
          return Opacity(
            opacity: s.enabled ? 1 : 0.4,
            child: InkWell(
              key: Key('service-${s.key}'),
              onTap: s.enabled ? () => onOpen?.call(s.key) : null,
              borderRadius: BorderRadius.circular(BesoncRadius.md),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    height: 46, width: 46,
                    decoration: BoxDecoration(
                      color: BesoncColors.brandSoft,
                      borderRadius: BorderRadius.circular(BesoncRadius.md),
                    ),
                    child: Icon(_icons[s.key] ?? Icons.category_outlined,
                        color: BesoncColors.brandDark, size: 22),
                  ),
                  const SizedBox(height: BesoncSpace.xs),
                  Text(s.label,
                      style: const TextStyle(fontSize: 11.5),
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (!s.enabled)
                    const Text('Soon',
                        style: TextStyle(
                            fontSize: 9, color: BesoncColors.inkMuted)),
                ],
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _StoreCarousel extends StatelessWidget {
  const _StoreCarousel({
    super.key, required this.title, required this.stores, this.onOpenStore,
  });

  final String title;
  final List<StoreCard> stores;
  final void Function(String)? onOpenStore;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
              BesoncSpace.lg, BesoncSpace.sm, BesoncSpace.lg, BesoncSpace.md),
          child: Text(title,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        ),
        SizedBox(
          height: 232,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.lg),
            itemCount: stores.length,
            separatorBuilder: (_, __) => const SizedBox(width: BesoncSpace.md),
            itemBuilder: (_, i) => StoreCardView(
              store: stores[i],
              onTap: () => onOpenStore?.call(stores[i].id),
            ),
          ),
        ),
      ],
    );
  }
}

/// Public so the service-listing screen reuses it.
class StoreCardView extends StatelessWidget {
  const StoreCardView({super.key, required this.store, this.onTap});
  final StoreCard store;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: Key('store-${store.id}'),
      onTap: store.isOpen ? onTap : null,
      borderRadius: BorderRadius.circular(BesoncRadius.lg),
      child: Opacity(
        opacity: store.isOpen ? 1 : 0.55,
        child: Container(
          width: 224,
          decoration: BoxDecoration(
            color: BesoncColors.surface,
            border: Border.all(color: BesoncColors.line),
            borderRadius: BorderRadius.circular(BesoncRadius.lg),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(BesoncRadius.lg)),
                child: BesoncImage(
                  url: store.imageUrl, fallbackLabel: store.name, height: 108,
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(BesoncSpace.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(store.name,
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 14.5, fontWeight: FontWeight.w700)),
                    const SizedBox(height: BesoncSpace.xs),
                    Row(
                      children: [
                        const Icon(Icons.star, size: 13, color: BesoncColors.warning),
                        const SizedBox(width: 3),
                        Text(store.rating.toStringAsFixed(1),
                            style: const TextStyle(fontSize: 12.5)),
                        const Text(' · ', style: TextStyle(color: BesoncColors.inkMuted)),
                        Flexible(
                          child: Text(store.prepEstimate,
                              maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontSize: 12.5, color: BesoncColors.inkMuted)),
                        ),
                      ],
                    ),
                    const SizedBox(height: BesoncSpace.xs),
                    // Closed vendors show WHEN they open — otherwise the
                    // customer has no idea whether to wait or move on.
                    store.isOpen
                        ? Text(
                            '${store.deliveryFee} delivery',
                            style: const TextStyle(
                                fontSize: 12.5, color: BesoncColors.inkMuted),
                          )
                        : BesoncBadge(
                            store.opensAt == null
                                ? 'Closed'
                                : 'Opens ${store.opensAt}',
                            tone: BesoncTone.warning,
                          ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HomeSkeleton extends StatelessWidget {
  const _HomeSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      key: Key('home-skeleton'),
      padding: EdgeInsets.all(BesoncSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BesoncSkeleton(height: 20, width: 180),
          SizedBox(height: BesoncSpace.lg),
          BesoncSkeleton(height: kMinTap),
          SizedBox(height: BesoncSpace.xl),
          BesoncSkeleton(height: 88),
          SizedBox(height: BesoncSpace.xl),
          BesoncSkeleton(height: 160),
        ],
      ),
    );
  }
}
