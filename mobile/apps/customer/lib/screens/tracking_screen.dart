/// Live order tracking. PDF §9.
///
/// The screen a customer stares at while their dinner is somewhere in
/// Accra traffic. Two rules govern it:
///
///   1. **Never claim to be live when it is not.** A dot that has not moved
///      for four minutes must say "Last seen 4 min ago", not pretend. The
///      controller already computes that honestly; this screen must not
///      paper over it.
///   2. **The progress line is the primary content**, not the map. On a
///      360dp phone with a rider still at the vendor, "Being prepared" is
///      the answer; a map showing a stationary dot is not.
library;

import 'package:flutter/material.dart';
import 'package:besonc_ui/besonc_ui.dart';

// Prefixed: Flutter's material library exports its own `ConnectionState`,
// and an ambiguous import is a confusing failure to debug.
import '../state/tracking_controller.dart' as tracking;
import '../state/tracking_controller.dart' show TrackingController;

class TrackingScreen extends StatelessWidget {
  const TrackingScreen({
    super.key,
    required this.controller,
    required this.humanRef,
    this.onCall,
    this.onChat,
    this.onCancel,
    this.onClose,
  });

  final TrackingController controller;
  final String humanRef;
  final VoidCallback? onCall;
  final VoidCallback? onChat;
  final VoidCallback? onCancel;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final terminal = controller.state.isTerminal;

        return Scaffold(
          backgroundColor: BesoncColors.canvas,
          appBar: AppBar(
            title: Text(humanRef),
            leading: IconButton(
              key: const Key('tracking-close'),
              icon: const Icon(Icons.close),
              onPressed: onClose,
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.only(bottom: BesoncSpace.xxl),
            children: [
              _StatusHeader(controller: controller),
              const SizedBox(height: BesoncSpace.md),
              _ProgressTrail(controller: controller),

              if (controller.riderName != null && !terminal) ...[
                const SizedBox(height: BesoncSpace.md),
                _RiderCard(
                  controller: controller,
                  onCall: onCall,
                  onChat: onChat,
                ),
              ],

              if (controller.error != null) ...[
                const SizedBox(height: BesoncSpace.md),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.md),
                  child: BesoncNotice(
                    key: const Key('tracking-error'),
                    message: controller.error!,
                    tone: BesoncTone.warning,
                  ),
                ),
              ],

              if (controller.canCancel) ...[
                const SizedBox(height: BesoncSpace.lg),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.md),
                  child: TextButton(
                    key: const Key('cancel-order'),
                    onPressed: () => _confirmCancel(context),
                    child: const Text(
                      'Cancel order',
                      style: TextStyle(color: BesoncColors.danger),
                    ),
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  /// The 50% warning is shown BEFORE the tap is committed, not after.
  Future<void> _confirmCancel(BuildContext context) async {
    final warning = controller.cancelWarning;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        key: const Key('cancel-dialog'),
        title: const Text('Cancel this order?'),
        content: Text(
          warning ?? 'You will be refunded in full.',
        ),
        actions: [
          TextButton(
            key: const Key('cancel-keep'),
            onPressed: () => Navigator.of(dialog).pop(false),
            child: const Text('Keep my order'),
          ),
          FilledButton(
            key: const Key('cancel-confirm'),
            style: FilledButton.styleFrom(backgroundColor: BesoncColors.danger),
            onPressed: () => Navigator.of(dialog).pop(true),
            child: const Text('Cancel order'),
          ),
        ],
      ),
    );

    if (confirmed == true) onCancel?.call();
  }
}

/* ------------------------------------------------------------------ */

class _StatusHeader extends StatelessWidget {
  const _StatusHeader({required this.controller});

  final TrackingController controller;

  @override
  Widget build(BuildContext context) {
    final eta = controller.etaLabel;
    final live = controller.connection == tracking.ConnectionState.live
        && !controller.positionIsStale;

    return Container(
      width: double.infinity,
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  controller.state.customerLabel,
                  key: const Key('tracking-state'),
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
                ),
              ),
              // Honest badge. It reads "Live" only when the last fix is
              // genuinely recent — the controller decides, not the UI.
              BesoncBadge(
                controller.connectionLabel,
                key: const Key('connection-badge'),
                tone: live ? BesoncTone.success : BesoncTone.warning,
              ),
            ],
          ),
          if (eta != null) ...[
            const SizedBox(height: BesoncSpace.sm),
            Text(
              eta,
              key: const Key('tracking-eta'),
              style: const TextStyle(fontSize: 15, color: BesoncColors.inkMuted),
            ),
          ],
        ],
      ),
    );
  }
}

/// The step trail. Deliberately text, not a map.
class _ProgressTrail extends StatelessWidget {
  const _ProgressTrail({required this.controller});

  final TrackingController controller;

  @override
  Widget build(BuildContext context) {
    final current = controller.progressStep;

    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.symmetric(vertical: BesoncSpace.md),
      child: Column(
        children: [
          for (var i = 0; i < TrackingController.progressLabels.length; i++)
            _Step(
              key: Key('step-$i'),
              label: TrackingController.progressLabels[i],
              done: current > i,
              active: current == i,
              isLast: i == TrackingController.progressLabels.length - 1,
            ),
        ],
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({
    super.key,
    required this.label,
    required this.done,
    required this.active,
    required this.isLast,
  });

  final String label;
  final bool done;
  final bool active;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final reached = done || active;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: BesoncSpace.lg),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Icon(
                done
                    ? Icons.check_circle
                    : active
                        ? Icons.radio_button_checked
                        : Icons.radio_button_unchecked,
                size: 20,
                color: reached ? BesoncColors.brandDark : BesoncColors.line,
              ),
              if (!isLast)
                Container(
                  width: 2,
                  height: 22,
                  color: done ? BesoncColors.brandDark : BesoncColors.line,
                ),
            ],
          ),
          const SizedBox(width: BesoncSpace.md),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 14.5,
                  fontWeight: active ? FontWeight.w700 : FontWeight.w400,
                  color: reached ? null : BesoncColors.inkMuted,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RiderCard extends StatelessWidget {
  const _RiderCard({required this.controller, this.onCall, this.onChat});

  final TrackingController controller;
  final VoidCallback? onCall;
  final VoidCallback? onChat;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: BesoncColors.surface,
      padding: const EdgeInsets.all(BesoncSpace.lg),
      child: Row(
        children: [
          const CircleAvatar(
            radius: 22,
            backgroundColor: BesoncColors.canvas,
            child: Icon(Icons.person, color: BesoncColors.inkMuted),
          ),
          const SizedBox(width: BesoncSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  controller.riderName!,
                  key: const Key('rider-name'),
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                if (controller.vehicle != null)
                  Text(
                    controller.vehicle!,
                    style: const TextStyle(
                      fontSize: 12.5, color: BesoncColors.inkMuted,
                    ),
                  ),
              ],
            ),
          ),
          // Calling is primary: on a bad connection a customer wants a
          // voice, not a chat thread.
          IconButton(
            key: const Key('call-rider'),
            icon: const Icon(Icons.phone, color: BesoncColors.brandDark),
            onPressed: onCall,
            tooltip: 'Call rider',
          ),
          Stack(
            children: [
              IconButton(
                key: const Key('chat-rider'),
                icon: const Icon(Icons.chat_bubble_outline),
                onPressed: onChat,
                tooltip: 'Message rider',
              ),
              if (controller.unreadMessages > 0)
                Positioned(
                  right: 6,
                  top: 6,
                  child: Container(
                    key: const Key('unread-dot'),
                    padding: const EdgeInsets.all(4),
                    decoration: const BoxDecoration(
                      color: BesoncColors.danger,
                      shape: BoxShape.circle,
                    ),
                    constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
                    child: Text(
                      '${controller.unreadMessages}',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: Colors.white, fontSize: 9, height: 1,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
