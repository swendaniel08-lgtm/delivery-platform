/// Rider app state. PDF §12.
///
/// The rider app is used on a phone clamped to a motorbike, in sunlight,
/// often one-handed at a junction. Three consequences:
///
///   1. There is exactly ONE next action at any moment. A rider should never
///      have to choose between buttons while moving.
///   2. The COD balance is permanently visible. It is the rider's debt to
///      the platform and the thing that gets them suspended.
///   3. Nothing destructive happens on a single tap. Completing a delivery
///      requires proof; collecting cash requires confirming the amount.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

enum LegState {
  pending, assigned, riderAtPickup, pickedUp, inTransit, arrived,
  completed, cancelled, unknown;

  static LegState fromWire(String s) => switch (s) {
        'pending' => LegState.pending,
        'assigned' => LegState.assigned,
        'rider_at_pickup' => LegState.riderAtPickup,
        'picked_up' => LegState.pickedUp,
        'in_transit' => LegState.inTransit,
        'arrived' => LegState.arrived,
        'completed' => LegState.completed,
        'cancelled' => LegState.cancelled,
        _ => LegState.unknown,
      };
}

/// COD thresholds, mirroring payment-svc (PDF §7).
const int kCodBlockPesewas = 30000;      // GHS 300 — no more cash orders
const int kCodWarnHours = 24;
const int kCodSuspendHours = 48;         // blocked from ALL work

enum CodStanding { clear, holding, blocked, warned, suspended }

class RiderAction {
  const RiderAction({
    required this.event,
    required this.label,
    this.requiresProof = false,
    this.requiresCashConfirmation = false,
  });

  final String event;
  final String label;
  final bool requiresProof;
  final bool requiresCashConfirmation;

  static const none = RiderAction(event: 'none', label: 'Waiting');
}

class ActiveLeg {
  const ActiveLeg({
    required this.legId,
    required this.orderId,
    required this.humanRef,
    required this.state,
    required this.service,
    required this.pickup,
    required this.dropoff,
    required this.fee,
    this.isCod = false,
    this.codAmount,
    this.pickupLabel = '',
    this.dropoffLabel = '',
    this.landmark,
    this.instructions,
    this.customerName,
  });

  final String legId;
  final String orderId;
  final String humanRef;
  final LegState state;
  final String service;
  final LatLng pickup;
  final LatLng dropoff;
  final Pesewas fee;
  final bool isCod;
  final Pesewas? codAmount;
  final String pickupLabel;
  final String dropoffLabel;
  final String? landmark;
  final String? instructions;
  final String? customerName;

  factory ActiveLeg.fromJson(Map<String, dynamic> j) {
    final p = j['pickup'] as Map<String, dynamic>;
    final d = j['dropoff'] as Map<String, dynamic>;
    return ActiveLeg(
      legId: j['legId'] as String,
      orderId: j['orderId'] as String,
      humanRef: j['humanRef'] as String,
      state: LegState.fromWire(j['state'] as String),
      service: j['service'] as String? ?? 'food',
      pickup: LatLng((p['lat'] as num).toDouble(), (p['lng'] as num).toDouble()),
      dropoff: LatLng((d['lat'] as num).toDouble(), (d['lng'] as num).toDouble()),
      fee: Pesewas.parse(j['feePesewas'] as String? ?? '0'),
      isCod: j['isCod'] as bool? ?? false,
      codAmount: Pesewas.tryParse(j['codAmountPesewas'] as String?),
      pickupLabel: p['label'] as String? ?? '',
      dropoffLabel: d['label'] as String? ?? '',
      landmark: d['landmark'] as String?,
      instructions: d['instructions'] as String?,
      customerName: j['customerName'] as String?,
    );
  }

  /// Before pickup the rider heads to the vendor; after, to the customer.
  bool get headingToPickup =>
      state == LegState.assigned || state == LegState.riderAtPickup;

  LatLng get navigationTarget => headingToPickup ? pickup : dropoff;
  String get navigationLabel => headingToPickup ? pickupLabel : dropoffLabel;

  /// The landmark only matters once the rider is going to the customer.
  /// Showing it earlier is clutter on a screen glanced at while riding.
  String? get visibleLandmark => headingToPickup ? null : landmark;

  RiderAction get nextAction => switch (state) {
        LegState.assigned =>
          const RiderAction(event: 'rider_arrive_pickup', label: 'Arrived at pickup'),
        LegState.riderAtPickup =>
          const RiderAction(event: 'rider_pickup', label: 'Picked up'),
        LegState.pickedUp || LegState.inTransit =>
          const RiderAction(event: 'rider_arrive', label: 'Arrived at customer'),
        LegState.arrived => RiderAction(
            event: 'rider_deliver',
            label: isCod ? 'Collect cash & complete' : 'Complete delivery',
            requiresProof: true,
            requiresCashConfirmation: isCod,
          ),
        _ => RiderAction.none,
      };
}

/// A broadcast offer with a 30-second window (PDF §4).
class DispatchOffer {
  const DispatchOffer({
    required this.legId,
    required this.orderId,
    required this.service,
    required this.pickupLabel,
    required this.dropoffArea,
    required this.earnings,
    required this.distanceMetres,
    required this.expiresAt,
    this.isCod = false,
  });

  final String legId;
  final String orderId;
  final String service;
  final String pickupLabel;

  /// Area only — the exact address is withheld until acceptance (PDF §4).
  final String dropoffArea;
  final Pesewas earnings;
  final int distanceMetres;
  final DateTime expiresAt;
  final bool isCod;

  factory DispatchOffer.fromJson(Map<String, dynamic> j) => DispatchOffer(
        legId: j['legId'] as String,
        orderId: j['orderId'] as String,
        service: j['service'] as String? ?? 'food',
        pickupLabel: j['pickupLabel'] as String? ?? '',
        dropoffArea: j['dropoffArea'] as String? ?? '',
        earnings: Pesewas.parse(j['earningsPesewas'] as String? ?? '0'),
        distanceMetres: j['distanceMetres'] as int? ?? 0,
        expiresAt: DateTime.parse(j['expiresAt'] as String),
        isCod: j['isCod'] as bool? ?? false,
      );

  String get distanceLabel => distanceMetres < 1000
      ? '$distanceMetres m'
      : '${(distanceMetres / 1000).toStringAsFixed(1)} km';
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

class RiderController extends ChangeNotifier {
  RiderController({DateTime Function()? clock}) : _now = clock ?? DateTime.now;

  final DateTime Function() _now;

  bool _isOnline = false;
  bool _approved = true;
  ActiveLeg? _leg;
  DispatchOffer? _offer;
  Pesewas _codObligation = const Pesewas(0);
  DateTime? _oldestUnremitted;
  Pesewas _todayEarnings = const Pesewas(0);
  int _todayDeliveries = 0;
  bool _submitting = false;

  bool get isOnline => _isOnline;
  bool get approved => _approved;
  ActiveLeg? get leg => _leg;
  DispatchOffer? get offer => _offer;
  Pesewas get codObligation => _codObligation;
  Pesewas get todayEarnings => _todayEarnings;
  int get todayDeliveries => _todayDeliveries;
  bool get submitting => _submitting;

  void setApproved(bool v) { _approved = v; notifyListeners(); }
  void setLeg(ActiveLeg? v) { _leg = v; notifyListeners(); }
  void setOffer(DispatchOffer? v) { _offer = v; notifyListeners(); }
  void setSubmitting(bool v) { _submitting = v; notifyListeners(); }

  void setEarnings({required Pesewas today, required int deliveries}) {
    _todayEarnings = today;
    _todayDeliveries = deliveries;
    notifyListeners();
  }

  void setCod({required Pesewas obligation, DateTime? oldestUnremitted}) {
    _codObligation = obligation;
    _oldestUnremitted = obligation.value > 0 ? oldestUnremitted : null;
    notifyListeners();
  }

  /* ---------------- COD standing ---------------- */

  double get _hoursOutstanding {
    if (_oldestUnremitted == null || _codObligation.value <= 0) return 0;
    return _now().difference(_oldestUnremitted!).inMinutes / 60.0;
  }

  CodStanding get codStanding {
    if (_codObligation.value <= 0) return CodStanding.clear;
    final hours = _hoursOutstanding;
    if (hours >= kCodSuspendHours) return CodStanding.suspended;
    if (hours >= kCodWarnHours) return CodStanding.warned;
    if (_codObligation.value > kCodBlockPesewas) return CodStanding.blocked;
    return CodStanding.holding;
  }

  /// Holding too MUCH blocks cash orders; holding too LONG blocks everything.
  /// That distinction is the difference between a limit and a debt.
  bool get canAcceptCod =>
      codStanding == CodStanding.clear || codStanding == CodStanding.holding;

  bool get canWork => codStanding != CodStanding.suspended;

  String? get codMessage => switch (codStanding) {
        CodStanding.suspended =>
          'Remit ${_codObligation.display} to start taking orders again',
        CodStanding.warned =>
          'Please remit ${_codObligation.display} — you will be suspended in '
              '${(kCodSuspendHours - _hoursOutstanding).ceil()} hours',
        CodStanding.blocked =>
          'Remit some cash to accept cash orders again',
        _ => null,
      };

  /// Withdrawable = wallet minus unremitted cash. Without this a rider can
  /// collect COD, cash out their earnings, and disappear with the float.
  Pesewas withdrawable(Pesewas walletBalance) {
    final available = walletBalance.value - _codObligation.value;
    return Pesewas(available > 0 ? available : 0);
  }

  /* ---------------- going online ---------------- */

  bool get canGoOnline => _approved && canWork && _leg == null;

  String? get onlineBlocker {
    if (!_approved) return 'Your account is still under review';
    if (!canWork) return codMessage;
    return null;
  }

  void setOnline(bool value) {
    if (value && !canGoOnline) return;
    _isOnline = value;
    notifyListeners();
  }

  /* ---------------- offers ---------------- */

  int secondsToDecide() {
    final o = _offer;
    if (o == null) return 0;
    final remaining = o.expiresAt.difference(_now()).inSeconds;
    return remaining < 0 ? 0 : remaining;
  }

  bool get offerExpired => _offer != null && secondsToDecide() == 0;

  /// A cash offer must be refused when the rider is already at the ceiling —
  /// better to never show Accept than to fail after they tap it.
  bool get canAcceptOffer {
    final o = _offer;
    if (o == null || offerExpired || _submitting) return false;
    if (o.isCod && !canAcceptCod) return false;
    return true;
  }

  String? get offerBlocker {
    final o = _offer;
    if (o == null) return null;
    if (offerExpired) return 'This offer expired';
    if (o.isCod && !canAcceptCod) {
      return 'Cash orders are unavailable until you remit';
    }
    return null;
  }

  /* ---------------- the active job ---------------- */

  RiderAction get nextAction => _leg?.nextAction ?? RiderAction.none;

  bool get hasActiveJob => _leg != null && _leg!.state != LegState.completed;

  /// Guards the action button. Proof and cash confirmation are enforced by
  /// the caller before this returns true.
  bool canAdvance({bool hasProof = false, bool cashConfirmed = false}) {
    if (_leg == null || _submitting) return false;
    final action = nextAction;
    if (action.event == 'none') return false;
    if (action.requiresProof && !hasProof) return false;
    if (action.requiresCashConfirmation && !cashConfirmed) return false;
    return true;
  }

  String? advanceBlocker({bool hasProof = false, bool cashConfirmed = false}) {
    if (_submitting) return 'Sending…';
    final action = nextAction;
    if (action.requiresProof && !hasProof) {
      return 'Take a photo of the delivery first';
    }
    if (action.requiresCashConfirmation && !cashConfirmed) {
      final amount = _leg?.codAmount?.display ?? '';
      return 'Confirm you collected $amount';
    }
    return null;
  }
}
