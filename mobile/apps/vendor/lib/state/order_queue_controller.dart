/// Vendor order queue. PDF §11.
///
/// The vendor app is used one-handed in a hot kitchen while cooking. The
/// hardest constraint is the 3-minute accept deadline: miss it and the order
/// auto-rejects, the customer is refunded, and the vendor takes an inaction
/// strike. So the countdown is the centre of this class.
///
/// Deliberate choice: the deadline is computed from the server's `placedAt`
/// timestamp, never from a local timer started when the push arrived. A push
/// delayed 40 seconds by the network would otherwise show the vendor 3:00
/// remaining when they actually have 2:20.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

/// PDF §11 — vendors have 3 minutes to accept or the order auto-rejects.
const Duration kAcceptWindow = Duration(minutes: 3);

/// Below this, the card turns red and the sound repeats.
const Duration kUrgentThreshold = Duration(seconds: 60);

enum VendorAction { accept, reject, markPreparing, markReady, awaitingRider, none }

class VendorOrderLine {
  const VendorOrderLine({
    required this.name,
    required this.quantity,
    this.addonNames = const [],
    this.variantNames = const [],
    this.note,
  });

  final String name;
  final int quantity;
  final List<String> addonNames;
  final List<String> variantNames;
  final String? note;

  factory VendorOrderLine.fromJson(Map<String, dynamic> j) => VendorOrderLine(
        name: j['name'] as String,
        quantity: j['quantity'] as int? ?? 1,
        addonNames: (j['addonNames'] as List<dynamic>? ?? [])
            .map((e) => e.toString())
            .toList(),
        variantNames: (j['variantNames'] as List<dynamic>? ?? [])
            .map((e) => e.toString())
            .toList(),
        note: j['note'] as String?,
      );

  /// One line the kitchen can read at a glance.
  String get kitchenLine {
    final buffer = StringBuffer('${quantity}x $name');
    final options = [...variantNames, ...addonNames];
    if (options.isNotEmpty) buffer.write(' (${options.join(', ')})');
    return buffer.toString();
  }
}

class VendorOrder {
  const VendorOrder({
    required this.id,
    required this.humanRef,
    required this.state,
    required this.lines,
    required this.itemTotal,
    required this.vendorAmount,
    required this.placedAt,
    this.isCod = false,
    this.requiresPrescription = false,
    this.riderName,
    this.customerNote,
  });

  final String id;
  final String humanRef;
  final OrderState state;
  final List<VendorOrderLine> lines;
  final Pesewas itemTotal;

  /// What the vendor actually earns, after commission.
  final Pesewas vendorAmount;
  final DateTime placedAt;
  final bool isCod;
  final bool requiresPrescription;
  final String? riderName;
  final String? customerNote;

  factory VendorOrder.fromJson(Map<String, dynamic> j) => VendorOrder(
        id: j['id'] as String,
        humanRef: j['humanRef'] as String,
        state: OrderState.fromWire(j['state'] as String),
        lines: (j['lines'] as List<dynamic>? ?? [])
            .map((l) => VendorOrderLine.fromJson(l as Map<String, dynamic>))
            .toList(),
        itemTotal: Pesewas.parse(j['itemTotalPesewas'] as String? ?? '0'),
        vendorAmount: Pesewas.parse(j['vendorAmountPesewas'] as String? ?? '0'),
        placedAt: DateTime.parse(j['placedAt'] as String),
        isCod: j['isCod'] as bool? ?? false,
        requiresPrescription: j['requiresPrescription'] as bool? ?? false,
        riderName: j['riderName'] as String?,
        customerNote: j['customerNote'] as String?,
      );

  int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

  bool get isNew =>
      state == OrderState.placed || state == OrderState.prescriptionReview;

  /// The single button this order should show.
  VendorAction get primaryAction => switch (state) {
        OrderState.placed => VendorAction.accept,
        OrderState.vendorAccepted => VendorAction.markPreparing,
        OrderState.preparing => VendorAction.markReady,
        OrderState.readyForPickup ||
        OrderState.riderAssigned ||
        OrderState.riderAtVendor =>
          VendorAction.awaitingRider,
        _ => VendorAction.none,
      };
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

class OrderQueueController extends ChangeNotifier {
  OrderQueueController({DateTime Function()? clock})
      : _now = clock ?? DateTime.now;

  final DateTime Function() _now;

  List<VendorOrder> _orders = const [];
  bool _isOpen = true;
  bool _loading = true;
  String? _error;

  /// Orders the vendor has acted on locally but the server has not confirmed.
  /// Keeps the button disabled so a double-tap cannot accept twice.
  final Set<String> _pending = {};

  bool get isOpen => _isOpen;
  bool get loading => _loading;
  String? get error => _error;
  bool isPending(String orderId) => _pending.contains(orderId);

  void setOrders(List<VendorOrder> value) {
    _orders = value;
    _loading = false;
    _error = null;
    notifyListeners();
  }

  void setError(String message) {
    _error = message;
    _loading = false;
    notifyListeners();
  }

  void setOpen(bool value) {
    _isOpen = value;
    notifyListeners();
  }

  void markPending(String orderId) {
    _pending.add(orderId);
    notifyListeners();
  }

  void clearPending(String orderId) {
    _pending.remove(orderId);
    notifyListeners();
  }

  /* ---------------- deadline ---------------- */

  /// Seconds left to accept, computed from the SERVER's placedAt.
  /// Returns null for orders that are not awaiting acceptance.
  int? secondsToRespond(VendorOrder order) {
    if (order.state != OrderState.placed) return null;
    final elapsed = _now().difference(order.placedAt);
    final remaining = kAcceptWindow - elapsed;
    return remaining.isNegative ? 0 : remaining.inSeconds;
  }

  bool isUrgent(VendorOrder order) {
    final secs = secondsToRespond(order);
    return secs != null && secs <= kUrgentThreshold.inSeconds;
  }

  /// True when the window has closed — the server is about to auto-reject.
  /// The card stays visible but the action is disabled, so the vendor sees
  /// what happened rather than an order silently vanishing.
  bool hasExpired(VendorOrder order) => secondsToRespond(order) == 0;

  String countdownLabel(VendorOrder order) {
    final secs = secondsToRespond(order);
    if (secs == null) return '';
    if (secs == 0) return 'Time up';
    final m = secs ~/ 60;
    final s = secs % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  /* ---------------- grouping ---------------- */

  /// New orders, MOST URGENT FIRST. The one about to auto-reject sits at the
  /// top where a busy cook will see it.
  List<VendorOrder> get newOrders {
    final list = _orders.where((o) => o.isNew).toList();
    list.sort((a, b) {
      final sa = secondsToRespond(a) ?? 1 << 30;
      final sb = secondsToRespond(b) ?? 1 << 30;
      return sa.compareTo(sb);
    });
    return list;
  }

  List<VendorOrder> get inProgress => _orders
      .where((o) => !o.isNew && !o.state.isTerminal)
      .toList();

  List<VendorOrder> get completed =>
      _orders.where((o) => o.state.isTerminal).toList();

  int get completedCount => completed.length;

  /// Sound and vibration only while something genuinely needs attention.
  bool get shouldAlert =>
      newOrders.any((o) => !hasExpired(o) && !isPending(o.id));

  /// Anything at all requiring the vendor's hands.
  bool get hasActionableWork => newOrders.isNotEmpty || inProgress.any(
      (o) => o.primaryAction != VendorAction.awaitingRider &&
             o.primaryAction != VendorAction.none);

  /* ---------------- today's summary ---------------- */

  /// Earnings shown to the vendor are AFTER commission. Showing gross would
  /// make every payout feel like an unexplained deduction.
  Pesewas get todayEarnings => Pesewas(
      completed.fold(0, (sum, o) => sum + o.vendorAmount.value));

  int get todayOrderCount => completed.length;

  /* ---------------- guards ---------------- */

  /// Whether the action button should be enabled.
  ///
  /// Blocked when: already submitting, the accept window has closed, or the
  /// shop is manually closed and this would take on new work.
  bool canAct(VendorOrder order) {
    if (_pending.contains(order.id)) return false;
    if (order.primaryAction == VendorAction.none) return false;
    if (order.primaryAction == VendorAction.awaitingRider) return false;
    if (order.state == OrderState.placed && hasExpired(order)) return false;
    return true;
  }

  String? blockedReason(VendorOrder order) {
    if (_pending.contains(order.id)) return 'Sending…';
    if (order.state == OrderState.placed && hasExpired(order)) {
      return 'This order timed out and was refunded';
    }
    if (order.primaryAction == VendorAction.awaitingRider) {
      return order.riderName == null
          ? 'Waiting for a rider'
          : '${order.riderName} is on the way';
    }
    return null;
  }

  /// Closing the shop must not strand orders already accepted.
  bool get canCloseShop => newOrders.isEmpty;

  String? get closeShopBlocker => canCloseShop
      ? null
      : 'Respond to ${newOrders.length} new order'
          '${newOrders.length == 1 ? '' : 's'} before closing';
}
