/// Rider home. PDF §12.
///
/// Glanced at on a mounted phone, in sunlight, at a junction. Everything is
/// oversized and there is never more than one primary action visible.
library;

import 'package:flutter/material.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';
import '../state/rider_controller.dart';

class RiderHomeScreen extends StatelessWidget {
  const RiderHomeScreen({
    super.key,
    required this.controller,
    required this.riderName,
    this.walletBalance,
    this.hasProof = false,
    this.cashConfirmed = false,
    this.onToggleOnline,
    this.onAdvance,
    this.onAcceptOffer,
    this.onDeclineOffer,
    this.onNavigate,
    this.onRemit,
    this.onTakeProof,
    this.onConfirmCash,
  });

  final RiderController controller;
  final String riderName;
  final Pesewas? walletBalance;
  final bool hasProof;
  final bool cashConfirmed;
  final void Function(bool)? onToggleOnline;
  final void Function(String event)? onAdvance;
  final VoidCallback? onAcceptOffer;
  final VoidCallback? onDeclineOffer;
  final VoidCallback? onNavigate;
  final VoidCallback? onRemit;
  final VoidCallback? onTakeProof;
  final VoidCallback? onConfirmCash;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        // A live offer takes over the whole screen: it has 30 seconds and
        // nothing else on this screen matters more.
        if (controller.offer != null && !controller.offerExpired) {
          return _OfferScreen(
            controller: controller,
            onAccept: onAcceptOffer,
            onDecline: onDeclineOffer,
          );
        }

        return Scaffold(
          backgroundColor: BesoncColors.canvas,
          body: SafeArea(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                _OnlineHeader(
                  controller: controller,
                  riderName: riderName,
                  onToggle: onToggleOnline,
                ),
                _EarningsStrip(controller: controller),
                if (controller.codObligation.value > 0)
                  _CodBanner(controller: controller, onRemit: onRemit),
                if (controller.hasActiveJob)
                  _ActiveJobCard(
                    controller: controller,
                    hasProof: hasProof,
                    cashConfirmed: cashConfirmed,
                    onAdvance: onAdvance,
                    onNavigate: onNavigate,
                    onTakeProof: onTakeProof,
                    onConfirmCash: onConfirmCash,
                  )
                else
                  _IdleState(controller: controller),
                const SizedBox(height: BesoncSpace.xxl),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _OnlineHeader extends StatelessWidget {
  const _OnlineHeader({
    required this.controller, required this.riderName, this.onToggle,
  });

  final RiderController controller;
  final String riderName;
  final void Function(bool)? onToggle;

  @override
  Widget build(BuildContext context) {
    final blocker = controller.onlineBlocker;
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(riderName,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: BesoncSpace.md),
          SizedBox(
            height: kPrimaryActionHeight,
            child: BesoncButton(
              key: const Key('online-toggle'),
              label: controller.isOnline ? 'You are ONLINE' : 'Go online',
              icon: controller.isOnline
                  ? Icons.check_circle
                  : Icons.play_circle_outline,
              danger: controller.isOnline,
              onPressed: (controller.isOnline || controller.canGoOnline)
                  ? () => onToggle?.call(!controller.isOnline)
                  : null,
            ),
          ),
          if (blocker != null) ...[
            const SizedBox(height: BesoncSpace.md),
            BesoncNotice(
              key: const Key('online-blocked'),
              message: blocker,
              tone: BesoncTone.danger,
            ),
          ],
        ],
      ),
    );
  }
}

class _EarningsStrip extends StatelessWidget {
  const _EarningsStrip({required this.controller});
  final RiderController controller;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.fromLTRB(
          BesoncSpace.lg, 0, BesoncSpace.lg, BesoncSpace.lg),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Earned today',
                    style: TextStyle(fontSize: 11, color: BesoncColors.inkMuted)),
                BesoncAmount(controller.todayEarnings.display, large: true),
              ],
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Deliveries',
                    style: TextStyle(fontSize: 11, color: BesoncColors.inkMuted)),
                Text('${controller.todayDeliveries}',
                    style: const TextStyle(
                        fontSize: 22, fontWeight: FontWeight.w700)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Cash owed is always visible. It is the rider's debt and the reason they
/// get suspended, so it is never tucked into a menu.
class _CodBanner extends StatelessWidget {
  const _CodBanner({required this.controller, this.onRemit});
  final RiderController controller;
  final VoidCallback? onRemit;

  @override
  Widget build(BuildContext context) {
    final standing = controller.codStanding;
    final critical = standing == CodStanding.suspended ||
        standing == CodStanding.warned ||
        standing == CodStanding.blocked;

    return Padding(
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Container(
        key: const Key('cod-banner'),
        padding: const EdgeInsets.all(BesoncSpace.lg),
        decoration: BoxDecoration(
          color: BesoncColors.cash.withValues(alpha: critical ? 0.16 : 0.08),
          border: Border.all(
            color: BesoncColors.cash.withValues(alpha: critical ? 0.7 : 0.3),
            width: critical ? 2 : 1,
          ),
          borderRadius: BorderRadius.circular(BesoncRadius.lg),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.payments_outlined,
                    color: BesoncColors.cash, size: 20),
                SizedBox(width: BesoncSpace.sm),
                Expanded(
                  child: Text('Cash you owe',
                      style: TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w600,
                          color: BesoncColors.cash)),
                ),
              ],
            ),
            const SizedBox(height: BesoncSpace.xs),
            BesoncAmount(controller.codObligation.display,
                isCash: true, large: true),
            if (controller.codMessage != null) ...[
              const SizedBox(height: BesoncSpace.sm),
              Text(controller.codMessage!,
                  key: const Key('cod-message'),
                  style: const TextStyle(
                      fontSize: 13, color: BesoncColors.cash)),
            ],
            const SizedBox(height: BesoncSpace.md),
            BesoncButton(
              key: const Key('remit-now'),
              label: 'Remit now',
              icon: Icons.upload,
              onPressed: onRemit,
            ),
          ],
        ),
      ),
    );
  }
}

class _ActiveJobCard extends StatelessWidget {
  const _ActiveJobCard({
    required this.controller,
    required this.hasProof,
    required this.cashConfirmed,
    this.onAdvance,
    this.onNavigate,
    this.onTakeProof,
    this.onConfirmCash,
  });

  final RiderController controller;
  final bool hasProof;
  final bool cashConfirmed;
  final void Function(String)? onAdvance;
  final VoidCallback? onNavigate;
  final VoidCallback? onTakeProof;
  final VoidCallback? onConfirmCash;

  @override
  Widget build(BuildContext context) {
    final leg = controller.leg!;
    final action = controller.nextAction;
    final blocker = controller.advanceBlocker(
        hasProof: hasProof, cashConfirmed: cashConfirmed);
    final canAdvance = controller.canAdvance(
        hasProof: hasProof, cashConfirmed: cashConfirmed);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.lg),
      child: Container(
        key: const Key('active-job'),
        padding: const EdgeInsets.all(BesoncSpace.lg),
        decoration: BoxDecoration(
          color: BesoncColors.surface,
          border: Border.all(color: BesoncColors.brand.withValues(alpha: 0.5)),
          borderRadius: BorderRadius.circular(BesoncRadius.lg),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // The fee is pinned right; the ref and badges share what is
            // left and wrap if they must. A plain Row overflows on a 360dp
            // phone as soon as a COD job adds the CASH badge — which is
            // exactly the job where the rider most needs to read this.
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: BesoncSpace.sm,
                    runSpacing: 4,
                    children: [
                      Text(leg.humanRef,
                          style: const TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w700)),
                      BesoncBadge(leg.service, tone: BesoncTone.brand),
                      if (leg.isCod)
                        const BesoncBadge('CASH', tone: BesoncTone.cash),
                    ],
                  ),
                ),
                const SizedBox(width: BesoncSpace.sm),
                BesoncAmount(leg.fee.display),
              ],
            ),
            const SizedBox(height: BesoncSpace.md),

            Text(leg.headingToPickup ? 'Collect from' : 'Deliver to',
                style: const TextStyle(
                    fontSize: 11, color: BesoncColors.inkMuted)),
            Text(leg.navigationLabel,
                key: const Key('nav-target'),
                style: const TextStyle(
                    fontSize: 19, fontWeight: FontWeight.w700)),

            // The landmark is what actually finds a Ghanaian address.
            if (leg.visibleLandmark != null) ...[
              const SizedBox(height: BesoncSpace.xs),
              Text(leg.visibleLandmark!,
                  key: const Key('landmark'),
                  style: const TextStyle(
                      fontSize: 15, color: BesoncColors.warning,
                      fontWeight: FontWeight.w600)),
            ],
            if (!leg.headingToPickup && leg.instructions != null) ...[
              const SizedBox(height: BesoncSpace.xs),
              Text(leg.instructions!,
                  style: const TextStyle(color: BesoncColors.inkMuted)),
            ],

            if (leg.isCod && leg.codAmount != null) ...[
              const SizedBox(height: BesoncSpace.md),
              Container(
                key: const Key('collect-amount'),
                width: double.infinity,
                padding: const EdgeInsets.all(BesoncSpace.md),
                decoration: BoxDecoration(
                  color: BesoncColors.cash.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(BesoncRadius.md),
                ),
                child: Row(
                  children: [
                    const Text('Collect ',
                        style: TextStyle(color: BesoncColors.cash)),
                    BesoncAmount(leg.codAmount!.display,
                        isCash: true, large: true),
                  ],
                ),
              ),
            ],

            const SizedBox(height: BesoncSpace.lg),
            OutlinedButton.icon(
              key: const Key('navigate'),
              onPressed: onNavigate,
              icon: const Icon(Icons.navigation_outlined),
              label: const Text('Navigate'),
            ),

            // Proof and cash confirmation appear only at the final step.
            if (action.requiresProof) ...[
              const SizedBox(height: BesoncSpace.md),
              OutlinedButton.icon(
                key: const Key('take-proof'),
                onPressed: onTakeProof,
                icon: Icon(hasProof ? Icons.check_circle : Icons.camera_alt),
                label: Text(hasProof ? 'Photo taken' : 'Take delivery photo'),
              ),
            ],
            if (action.requiresCashConfirmation) ...[
              const SizedBox(height: BesoncSpace.sm),
              OutlinedButton.icon(
                key: const Key('confirm-cash'),
                onPressed: onConfirmCash,
                icon: Icon(
                    cashConfirmed ? Icons.check_circle : Icons.payments),
                label: Text(cashConfirmed
                    ? 'Cash confirmed'
                    : 'I collected ${leg.codAmount?.display ?? ''}'),
              ),
            ],

            const SizedBox(height: BesoncSpace.md),
            if (blocker != null)
              BesoncNotice(
                key: const Key('advance-blocked'),
                message: blocker,
                tone: BesoncTone.warning,
              )
            else
              BesoncButton(
                key: const Key('advance'),
                label: action.label,
                onPressed:
                    canAdvance ? () => onAdvance?.call(action.event) : null,
              ),
          ],
        ),
      ),
    );
  }
}

class _IdleState extends StatelessWidget {
  const _IdleState({required this.controller});
  final RiderController controller;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: BesoncSpace.xxl),
      child: BesoncEmpty(
        key: const Key('idle'),
        icon: controller.isOnline ? Icons.search : Icons.pause_circle_outline,
        title: controller.isOnline
            ? 'Looking for deliveries'
            : 'You are offline',
        message: controller.isOnline
            ? 'You will hear a sound when a delivery is available.'
            : 'Go online to start receiving deliveries.',
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Offer takeover                                                      */
/* ------------------------------------------------------------------ */

class _OfferScreen extends StatelessWidget {
  const _OfferScreen({required this.controller, this.onAccept, this.onDecline});

  final RiderController controller;
  final VoidCallback? onAccept;
  final VoidCallback? onDecline;

  @override
  Widget build(BuildContext context) {
    final offer = controller.offer!;
    final seconds = controller.secondsToDecide();
    final blocker = controller.offerBlocker;

    return Scaffold(
      backgroundColor: BesoncColors.brandDark,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(BesoncSpace.xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('NEW DELIVERY',
                      style: TextStyle(
                          color: Colors.white70, fontSize: 13,
                          fontWeight: FontWeight.w700, letterSpacing: 1.2)),
                  const Spacer(),
                  Text('$seconds',
                      key: const Key('offer-countdown'),
                      style: const TextStyle(
                          color: Colors.white, fontSize: 34,
                          fontWeight: FontWeight.w800,
                          fontFeatures: [FontFeature.tabularFigures()])),
                ],
              ),
              const SizedBox(height: BesoncSpace.xl),
              Text(offer.earnings.display,
                  key: const Key('offer-earnings'),
                  style: const TextStyle(
                      color: Colors.white, fontSize: 40,
                      fontWeight: FontWeight.w800)),
              const Text('you earn',
                  style: TextStyle(color: Colors.white70)),
              const SizedBox(height: BesoncSpace.xl),
              _OfferRow(label: 'Pick up', value: offer.pickupLabel),
              // Only the AREA before acceptance (PDF §4).
              _OfferRow(label: 'Deliver to', value: offer.dropoffArea),
              _OfferRow(label: 'Distance', value: offer.distanceLabel),
              if (offer.isCod)
                const Padding(
                  padding: EdgeInsets.only(top: BesoncSpace.md),
                  child: BesoncBadge('COLLECT CASH', tone: BesoncTone.cash),
                ),
              const Spacer(),
              if (blocker != null)
                BesoncNotice(
                  key: const Key('offer-blocked'),
                  message: blocker,
                  tone: BesoncTone.danger,
                )
              else
                BesoncButton(
                  key: const Key('accept-offer'),
                  label: 'Accept',
                  onPressed: controller.canAcceptOffer ? onAccept : null,
                ),
              const SizedBox(height: BesoncSpace.md),
              SizedBox(
                height: kMinTap,
                child: OutlinedButton(
                  key: const Key('decline-offer'),
                  onPressed: onDecline,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white70,
                    side: const BorderSide(color: Colors.white24),
                  ),
                  child: const Text('Decline'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _OfferRow extends StatelessWidget {
  const _OfferRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: BesoncSpace.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 96,
              child: Text(label,
                  style: const TextStyle(color: Colors.white60, fontSize: 13)),
            ),
            Expanded(
              child: Text(value,
                  style: const TextStyle(
                      color: Colors.white, fontSize: 16,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      );
}
