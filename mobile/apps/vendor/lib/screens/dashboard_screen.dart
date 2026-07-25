/// Vendor dashboard. PDF §11.
///
/// Read at arm's length, in a kitchen, by someone holding a ladle. So:
/// large type, one action per card, the countdown impossible to miss, and
/// the new-orders section pinned above everything else.
library;

import 'package:flutter/material.dart';
import 'package:besonc_ui/besonc_ui.dart';
import '../state/order_queue_controller.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({
    super.key,
    required this.controller,
    required this.storeName,
    this.rating = 0,
    this.onAct,
    this.onToggleOpen,
    this.onRetry,
    this.onOpenOrder,
  });

  final OrderQueueController controller;
  final String storeName;
  final double rating;

  /// (orderId, action) — the parent performs the API call.
  final void Function(String, VendorAction)? onAct;
  final void Function(bool)? onToggleOpen;
  final VoidCallback? onRetry;
  final void Function(String)? onOpenOrder;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        if (controller.loading) {
          return const Scaffold(
            body: SafeArea(
              child: Padding(
                key: Key('dashboard-skeleton'),
                padding: EdgeInsets.all(BesoncSpace.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    BesoncSkeleton(height: 28, width: 200),
                    SizedBox(height: BesoncSpace.lg),
                    BesoncSkeleton(height: 72),
                    SizedBox(height: BesoncSpace.lg),
                    BesoncSkeleton(height: 140),
                  ],
                ),
              ),
            ),
          );
        }

        if (controller.error != null) {
          return Scaffold(
            body: SafeArea(
              child: BesoncEmpty(
                key: const Key('dashboard-error'),
                icon: Icons.wifi_off,
                title: 'Cannot reach Besonc',
                message: controller.error,
                onRetry: onRetry,
              ),
            ),
          );
        }

        return Scaffold(
          backgroundColor: BesoncColors.canvas,
          body: SafeArea(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                _Header(
                  storeName: storeName,
                  controller: controller,
                  onToggleOpen: onToggleOpen,
                ),
                _TodayStrip(controller: controller, rating: rating),

                if (controller.newOrders.isNotEmpty)
                  _Section(
                    key: const Key('section-new'),
                    title: 'New orders',
                    count: controller.newOrders.length,
                    tone: BesoncTone.danger,
                    children: [
                      for (final o in controller.newOrders)
                        _NewOrderCard(
                          order: o,
                          controller: controller,
                          onAct: onAct,
                          onOpen: onOpenOrder,
                        ),
                    ],
                  ),

                if (controller.inProgress.isNotEmpty)
                  _Section(
                    key: const Key('section-progress'),
                    title: 'In progress',
                    count: controller.inProgress.length,
                    children: [
                      for (final o in controller.inProgress)
                        _ProgressCard(
                          order: o,
                          controller: controller,
                          onAct: onAct,
                          onOpen: onOpenOrder,
                        ),
                    ],
                  ),

                if (controller.newOrders.isEmpty &&
                    controller.inProgress.isEmpty)
                  const Padding(
                    key: Key('all-clear'),
                    padding: EdgeInsets.symmetric(vertical: BesoncSpace.xxl),
                    child: BesoncEmpty(
                      icon: Icons.check_circle_outline,
                      title: 'All caught up',
                      message: 'New orders will appear here with a sound.',
                    ),
                  ),

                Padding(
                  padding: const EdgeInsets.all(BesoncSpace.lg),
                  child: Text(
                    'Completed today: ${controller.completedCount}',
                    style: const TextStyle(color: BesoncColors.inkMuted),
                  ),
                ),
                const SizedBox(height: BesoncSpace.xl),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.storeName, required this.controller, this.onToggleOpen,
  });

  final String storeName;
  final OrderQueueController controller;
  final void Function(bool)? onToggleOpen;

  @override
  Widget build(BuildContext context) {
    final blocked = controller.closeShopBlocker;
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  storeName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 18, fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: BesoncSpace.md),
              // Closing must not strand unanswered orders.
              Switch(
                key: const Key('open-toggle'),
                value: controller.isOpen,
                onChanged: (controller.isOpen && !controller.canCloseShop)
                    ? null
                    : onToggleOpen,
              ),
            ],
          ),
          Text(
            controller.isOpen ? 'Open — accepting orders' : 'Closed',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: controller.isOpen
                  ? BesoncColors.success
                  : BesoncColors.inkMuted,
            ),
          ),
          if (controller.isOpen && blocked != null) ...[
            const SizedBox(height: BesoncSpace.md),
            BesoncNotice(
              key: const Key('close-blocked'),
              message: blocked,
              tone: BesoncTone.warning,
            ),
          ],
        ],
      ),
    );
  }
}

class _TodayStrip extends StatelessWidget {
  const _TodayStrip({required this.controller, required this.rating});
  final OrderQueueController controller;
  final double rating;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.fromLTRB(
          BesoncSpace.lg, 0, BesoncSpace.lg, BesoncSpace.lg),
      child: Row(
        children: [
          _Stat(label: 'Orders', value: '${controller.todayOrderCount}'),
          // The vendor sees what they EARN, not the order total.
          _Stat(
            key: const Key('stat-earnings'),
            label: 'Earned',
            value: controller.todayEarnings.display,
          ),
          _Stat(
            label: 'Rating',
            value: rating > 0 ? rating.toStringAsFixed(1) : '—',
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({super.key, required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: const TextStyle(
                    fontSize: 11, color: BesoncColors.inkMuted)),
            const SizedBox(height: 2),
            Text(value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontSize: 17, fontWeight: FontWeight.w700)),
          ],
        ),
      );
}

class _Section extends StatelessWidget {
  const _Section({
    super.key, required this.title, required this.count,
    required this.children, this.tone = BesoncTone.neutral,
  });

  final String title;
  final int count;
  final List<Widget> children;
  final BesoncTone tone;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
              BesoncSpace.lg, BesoncSpace.lg, BesoncSpace.lg, BesoncSpace.sm),
          child: Row(
            children: [
              Text(title,
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(width: BesoncSpace.sm),
              BesoncBadge('$count', tone: tone),
            ],
          ),
        ),
        ...children,
      ],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

class _NewOrderCard extends StatelessWidget {
  const _NewOrderCard({
    required this.order, required this.controller, this.onAct, this.onOpen,
  });

  final VendorOrder order;
  final OrderQueueController controller;
  final void Function(String, VendorAction)? onAct;
  final void Function(String)? onOpen;

  @override
  Widget build(BuildContext context) {
    final urgent = controller.isUrgent(order);
    final expired = controller.hasExpired(order);
    final canAct = controller.canAct(order);

    return Padding(
      padding: const EdgeInsets.fromLTRB(
          BesoncSpace.lg, 0, BesoncSpace.lg, BesoncSpace.md),
      child: Container(
        key: Key('order-${order.id}'),
        decoration: BoxDecoration(
          color: BesoncColors.surface,
          borderRadius: BorderRadius.circular(BesoncRadius.lg),
          border: Border.all(
            color: expired
                ? BesoncColors.line
                : urgent
                    ? BesoncColors.danger
                    : BesoncColors.brand.withValues(alpha: 0.45),
            width: urgent && !expired ? 2 : 1,
          ),
        ),
        padding: const EdgeInsets.all(BesoncSpace.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(order.humanRef,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700)),
                const SizedBox(width: BesoncSpace.sm),
                if (order.isCod)
                  const BesoncBadge('CASH', tone: BesoncTone.cash),
                if (order.requiresPrescription) ...[
                  const SizedBox(width: BesoncSpace.xs),
                  const BesoncBadge('Rx', tone: BesoncTone.info),
                ],
                const Spacer(),
                // The countdown is the loudest thing on the card.
                Text(
                  controller.countdownLabel(order),
                  key: Key('countdown-${order.id}'),
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w800,
                    fontFeatures: const [FontFeature.tabularFigures()],
                    color: expired
                        ? BesoncColors.inkMuted
                        : urgent
                            ? BesoncColors.danger
                            : BesoncColors.ink,
                  ),
                ),
              ],
            ),
            const SizedBox(height: BesoncSpace.md),
            for (final line in order.lines)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(line.kitchenLine,
                    style: const TextStyle(fontSize: 15)),
              ),
            if (order.lines.any((l) => l.note != null)) ...[
              const SizedBox(height: BesoncSpace.xs),
              for (final l in order.lines.where((l) => l.note != null))
                Text('Note: ${l.note}',
                    style: const TextStyle(
                        fontSize: 13,
                        fontStyle: FontStyle.italic,
                        color: BesoncColors.warning)),
            ],
            const SizedBox(height: BesoncSpace.md),
            Row(
              children: [
                const Text('You earn ',
                    style: TextStyle(color: BesoncColors.inkMuted)),
                BesoncAmount(order.vendorAmount.display),
              ],
            ),
            const SizedBox(height: BesoncSpace.md),

            if (controller.blockedReason(order) != null)
              BesoncNotice(
                key: Key('blocked-${order.id}'),
                message: controller.blockedReason(order)!,
                tone: expired ? BesoncTone.danger : BesoncTone.neutral,
              )
            else
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: Key('reject-${order.id}'),
                      onPressed: canAct
                          ? () => onAct?.call(order.id, VendorAction.reject)
                          : null,
                      child: const Text('Reject'),
                    ),
                  ),
                  const SizedBox(width: BesoncSpace.md),
                  Expanded(
                    flex: 2,
                    child: BesoncButton(
                      key: Key('accept-${order.id}'),
                      label: 'Accept',
                      onPressed: canAct
                          ? () => onAct?.call(order.id, VendorAction.accept)
                          : null,
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _ProgressCard extends StatelessWidget {
  const _ProgressCard({
    required this.order, required this.controller, this.onAct, this.onOpen,
  });

  final VendorOrder order;
  final OrderQueueController controller;
  final void Function(String, VendorAction)? onAct;
  final void Function(String)? onOpen;

  String get _label => switch (order.primaryAction) {
        VendorAction.markPreparing => 'Start preparing',
        VendorAction.markReady => 'Ready for pickup',
        _ => '',
      };

  @override
  Widget build(BuildContext context) {
    final blocked = controller.blockedReason(order);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          BesoncSpace.lg, 0, BesoncSpace.lg, BesoncSpace.md),
      child: Container(
        key: Key('order-${order.id}'),
        decoration: BoxDecoration(
          color: BesoncColors.surface,
          borderRadius: BorderRadius.circular(BesoncRadius.lg),
          border: Border.all(color: BesoncColors.line),
        ),
        padding: const EdgeInsets.all(BesoncSpace.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(order.humanRef,
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700)),
                const SizedBox(width: BesoncSpace.sm),
                if (order.isCod)
                  const BesoncBadge('CASH', tone: BesoncTone.cash),
                const Spacer(),
                Text('${order.itemCount} item'
                    '${order.itemCount == 1 ? '' : 's'}',
                    style: const TextStyle(color: BesoncColors.inkMuted)),
              ],
            ),
            const SizedBox(height: BesoncSpace.sm),
            for (final line in order.lines)
              Text(line.kitchenLine, style: const TextStyle(fontSize: 14)),
            const SizedBox(height: BesoncSpace.md),
            if (blocked != null)
              BesoncNotice(
                key: Key('blocked-${order.id}'),
                message: blocked,
                tone: BesoncTone.info,
              )
            else
              BesoncButton(
                key: Key('advance-${order.id}'),
                label: _label,
                onPressed: controller.canAct(order)
                    ? () => onAct?.call(order.id, order.primaryAction)
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}
