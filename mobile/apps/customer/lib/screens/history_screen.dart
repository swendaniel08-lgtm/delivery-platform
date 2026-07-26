/// Order history.
///
/// Most visits here are one of three things: find a receipt, reorder
/// something, or check a charge. The third is why every failure state below
/// is explicit — a customer who opens this screen to verify a payment and
/// sees a blank list will assume the worst, and phone.
library;

import 'package:flutter/material.dart';
import 'package:besonc_ui/besonc_ui.dart';
import 'package:besonc_models/besonc_models.dart';

import '../state/history_controller.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({
    super.key,
    required this.controller,
    this.onOpenOrder,
    this.onClose,
  });

  final HistoryController controller;
  final void Function(HistoryOrder)? onOpenOrder;
  final VoidCallback? onClose;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    // Fetch before the customer actually reaches the bottom, so on a slow
    // connection the next page is usually there by the time they arrive.
    final remaining = _scroll.position.maxScrollExtent - _scroll.position.pixels;
    if (remaining < 400) widget.controller.loadMore();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;

    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      appBar: AppBar(
        title: const Text('Your orders'),
        leading: widget.onClose == null
            ? null
            : IconButton(
                key: const Key('history-close'),
                icon: const Icon(Icons.close),
                onPressed: widget.onClose,
              ),
      ),
      body: AnimatedBuilder(
        animation: c,
        builder: (context, _) {
          // The first load, with nothing to show yet.
          if (c.loading && c.orders.isEmpty) {
            return const Center(
              key: Key('history-loading'),
              child: CircularProgressIndicator(),
            );
          }

          // Failed with nothing on screen. Deliberately NOT the empty state:
          // "you have no orders" would be a lie the customer might act on.
          if (c.error != null && c.orders.isEmpty) {
            return _Failed(
              message: c.error!,
              onRetry: c.refresh,
            );
          }

          if (c.isEmpty) return const _NoOrdersYet();

          return RefreshIndicator(
            onRefresh: c.refresh,
            child: ListView.builder(
              key: const Key('history-list'),
              controller: _scroll,
              padding: const EdgeInsets.symmetric(vertical: BesoncSpace.sm),
              // +1 for the footer, and +1 more when a stale-refresh banner
              // needs to sit above the list.
              itemCount: c.orders.length + 1 + (c.error != null ? 1 : 0),
              itemBuilder: (context, i) {
                if (c.error != null) {
                  if (i == 0) return _StaleBanner(message: c.error!);
                  i -= 1;
                }
                if (i == c.orders.length) return _Footer(controller: c);
                final o = c.orders[i];
                return _OrderTile(
                  order: o,
                  onTap: widget.onOpenOrder == null
                      ? null
                      : () => widget.onOpenOrder!(o),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

class _OrderTile extends StatelessWidget {
  const _OrderTile({required this.order, this.onTap});

  final HistoryOrder order;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: Key('history-order-${order.id}'),
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(
          horizontal: BesoncSpace.md, vertical: BesoncSpace.xs,
        ),
        padding: const EdgeInsets.all(BesoncSpace.md),
        decoration: BoxDecoration(
          color: BesoncColors.surface,
          borderRadius: BorderRadius.circular(BesoncRadius.md),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    order.storeName ?? _serviceLabel(order.service),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(width: BesoncSpace.sm),
                // Amount pinned right and never truncated: it is the reason
                // most people opened this screen.
                BesoncAmount(order.totalDisplay, isCash: order.isCod),
              ],
            ),
            const SizedBox(height: BesoncSpace.xs),
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${order.humanRef} · ${_when(order.placedAt)}'
                    '${order.itemCount > 0 ? ' · ${order.itemCount} item'
                        '${order.itemCount == 1 ? '' : 's'}' : ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12, color: BesoncColors.inkMuted,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: BesoncSpace.sm),
            Wrap(
              spacing: BesoncSpace.xs,
              runSpacing: BesoncSpace.xs,
              children: [
                BesoncBadge(
                  order.state.customerLabel,
                  key: Key('history-state-${order.id}'),
                  tone: _tone(order.state),
                ),
                // An in-flight order at the top of history is the one the
                // customer most likely came to tap.
                if (order.isActive)
                  const BesoncBadge('Track', tone: BesoncTone.brand),
                if (order.isCod)
                  const BesoncBadge('Cash', tone: BesoncTone.cash),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static BesoncTone _tone(OrderState s) {
    if (s == OrderState.cancelled ||
        s == OrderState.failed ||
        s == OrderState.vendorRejected) {
      return BesoncTone.danger;
    }
    if (s.isTerminal) return BesoncTone.success;
    return BesoncTone.info;
  }

  static String _serviceLabel(String service) =>
      service.isEmpty ? 'Order' : service[0].toUpperCase() + service.substring(1);

  /// Relative for anything recent, absolute once it stops being memorable.
  static String _when(DateTime t) {
    if (t.millisecondsSinceEpoch == 0) return 'date unknown';
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    if (d.inDays == 1) return 'yesterday';
    if (d.inDays < 7) return '${d.inDays} days ago';
    return '${t.day}/${t.month}/${t.year}';
  }
}

/* ------------------------------------------------------------------ */

class _Footer extends StatelessWidget {
  const _Footer({required this.controller});
  final HistoryController controller;

  @override
  Widget build(BuildContext context) {
    if (controller.loadingMore) {
      return const Padding(
        key: Key('history-loading-more'),
        padding: EdgeInsets.all(BesoncSpace.lg),
        child: Center(
          child: SizedBox(
            width: 20, height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }

    // A page failed. The rows above are still good, so this offers a retry
    // rather than replacing the screen with an error.
    if (controller.pageError != null) {
      return Padding(
        key: const Key('history-page-error'),
        padding: const EdgeInsets.all(BesoncSpace.lg),
        child: Center(
          child: TextButton(
            onPressed: controller.loadMore,
            child: Text('${controller.pageError!} · Tap to retry'),
          ),
        ),
      );
    }

    if (!controller.hasMore && controller.orders.isNotEmpty) {
      return const Padding(
        key: Key('history-end'),
        padding: EdgeInsets.all(BesoncSpace.lg),
        child: Center(
          child: Text(
            'That’s everything',
            style: TextStyle(fontSize: 12, color: BesoncColors.inkMuted),
          ),
        ),
      );
    }

    return const SizedBox(height: BesoncSpace.xl);
  }
}

class _NoOrdersYet extends StatelessWidget {
  const _NoOrdersYet();

  @override
  Widget build(BuildContext context) => const Center(
        key: Key('history-empty'),
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 40),
          child: Text(
            'You haven’t placed an order yet.\n'
            'Anything you order will show up here.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: BesoncColors.inkMuted),
          ),
        ),
      );
}

class _Failed extends StatelessWidget {
  const _Failed({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) => Center(
        key: const Key('history-error'),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 14, color: BesoncColors.inkMuted),
              ),
              const SizedBox(height: BesoncSpace.md),
              // Says nothing about whether orders exist — only that we could
              // not reach them.
              OutlinedButton(
                key: const Key('history-retry'),
                onPressed: onRetry,
                child: const Text('Try again'),
              ),
            ],
          ),
        ),
      );
}

class _StaleBanner extends StatelessWidget {
  const _StaleBanner({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => Padding(
        key: const Key('history-stale'),
        padding: const EdgeInsets.fromLTRB(
          BesoncSpace.md, BesoncSpace.xs, BesoncSpace.md, BesoncSpace.xs,
        ),
        child: BesoncNotice(message: message, tone: BesoncTone.warning),
      );
}
