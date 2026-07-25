/// Live order tracking. PDF §9.
///
/// The socket is the primary source and polling is the fallback, because on
/// Ghanaian mobile data the WebSocket WILL drop — riding through a dead spot,
/// switching cell towers, the OS suspending the app in the background.
///
/// Two rules shape everything here:
///   1. Never show a stale position as if it were live. A dot that has not
///      moved for four minutes must say so.
///   2. Never let the ETA run backwards or tick past zero into nonsense.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

enum ConnectionState { connecting, live, degraded, offline }

class RiderPosition {
  const RiderPosition({
    required this.position,
    required this.receivedAt,
    this.etaSeconds,
  });

  final LatLng position;
  final DateTime receivedAt;
  final int? etaSeconds;
}

/// How long before a position is treated as stale rather than live.
const Duration kStaleAfter = Duration(seconds: 45);

/// How long before we stop claiming to know where the rider is at all.
const Duration kVeryStaleAfter = Duration(minutes: 3);

class TrackingController extends ChangeNotifier {
  TrackingController({
    required this.orderId,
    required OrderState initialState,
    DateTime Function()? clock,
  })  : _state = initialState,
        _now = clock ?? DateTime.now;

  final String orderId;
  final DateTime Function() _now;

  OrderState _state;
  RiderPosition? _rider;
  ConnectionState _connection = ConnectionState.connecting;
  String? _riderName;
  String? _riderPhone;
  String? _vehicle;
  int _unreadMessages = 0;
  String? _error;

  OrderState get state => _state;
  RiderPosition? get rider => _rider;
  ConnectionState get connection => _connection;
  String? get riderName => _riderName;
  String? get vehicle => _vehicle;
  int get unreadMessages => _unreadMessages;
  String? get error => _error;

  /// The rider's number is only available while the delivery is live
  /// (issue #3 v1 — consented calling inside the delivery window).
  String? get riderPhone => _state.isTerminal ? null : _riderPhone;

  bool get canChat => !_state.isTerminal && _riderName != null;
  bool get showMap => _state.isTrackable && _rider != null;

  /* ---------------- socket events ---------------- */

  void onConnected() {
    _connection = ConnectionState.live;
    _error = null;
    notifyListeners();
  }

  void onDisconnected() {
    // Degraded, not offline: we still have the last known position and the
    // poller may keep the screen useful.
    _connection = ConnectionState.degraded;
    notifyListeners();
  }

  void onOffline(String message) {
    _connection = ConnectionState.offline;
    _error = message;
    notifyListeners();
  }

  void onPosition(LatLng position, {int? etaSeconds}) {
    _rider = RiderPosition(
      position: position, receivedAt: _now(), etaSeconds: etaSeconds,
    );
    if (_connection != ConnectionState.live) _connection = ConnectionState.live;
    notifyListeners();
  }

  void onStateChanged(OrderState next) {
    _state = next;
    // A finished order must stop rendering a live map and drop the rider's
    // contact details immediately.
    if (next.isTerminal) {
      _rider = null;
      _connection = ConnectionState.offline;
    }
    notifyListeners();
  }

  void setRider({String? name, String? phone, String? vehicle}) {
    _riderName = name;
    _riderPhone = phone;
    _vehicle = vehicle;
    notifyListeners();
  }

  void setUnreadMessages(int count) {
    _unreadMessages = count < 0 ? 0 : count;
    notifyListeners();
  }

  /* ---------------- staleness ---------------- */

  Duration? get positionAge =>
      _rider == null ? null : _now().difference(_rider!.receivedAt);

  bool get positionIsStale {
    final age = positionAge;
    return age != null && age > kStaleAfter;
  }

  bool get positionIsVeryStale {
    final age = positionAge;
    return age != null && age > kVeryStaleAfter;
  }

  /// Honest status line. Never claims live tracking when it is not live.
  String get connectionLabel {
    if (_state.isTerminal) return _state.customerLabel;
    if (positionIsVeryStale) return 'Reconnecting to your rider…';
    if (_connection == ConnectionState.offline) return 'You are offline';
    if (_connection == ConnectionState.degraded || positionIsStale) {
      return 'Last seen ${_ageLabel()}';
    }
    if (_connection == ConnectionState.connecting) return 'Connecting…';
    return 'Live';
  }

  String _ageLabel() {
    final age = positionAge;
    if (age == null) return 'a moment ago';
    if (age.inSeconds < 60) return '${age.inSeconds}s ago';
    return '${age.inMinutes} min ago';
  }

  /* ---------------- ETA ---------------- */

  /// Counts down between server updates instead of freezing on the last
  /// value, but never below zero and never upward from a stale reading.
  int? get etaSeconds {
    final r = _rider;
    if (r?.etaSeconds == null) return null;
    if (positionIsVeryStale) return null; // do not guess from an old fix
    final elapsed = _now().difference(r!.receivedAt).inSeconds;
    final remaining = r.etaSeconds! - elapsed;
    return remaining < 0 ? 0 : remaining;
  }

  /// Customer-facing ETA. Deliberately coarse: promising "3 minutes" to the
  /// second invites complaints that a range does not.
  String? get etaLabel {
    final secs = etaSeconds;
    if (secs == null) return null;
    if (secs == 0) return 'Arriving now';
    final mins = (secs / 60).ceil();
    if (mins <= 1) return 'Less than a minute';
    if (mins <= 5) return 'About $mins minutes';
    return 'About ${(mins / 5).round() * 5} minutes';
  }

  /* ---------------- progress ---------------- */

  /// Step index for the progress indicator, or -1 when not applicable.
  int get progressStep => switch (_state) {
        OrderState.placed || OrderState.pendingPayment => 0,
        OrderState.vendorAccepted || OrderState.preparing => 1,
        OrderState.readyForPickup ||
        OrderState.riderAssigned ||
        OrderState.riderAtVendor =>
          2,
        OrderState.pickedUp || OrderState.inTransit => 3,
        OrderState.arrived => 4,
        OrderState.delivered || OrderState.deliveredToCustomer => 5,
        _ => -1,
      };

  static const progressLabels = [
    'Order placed', 'Being prepared', 'Rider collecting',
    'On the way', 'Arrived', 'Delivered',
  ];

  /// Cancellation rules mirror PDF §8 so the button disappears at the right
  /// moment rather than failing server-side.
  bool get canCancel => switch (_state) {
        OrderState.pendingPayment ||
        OrderState.placed ||
        OrderState.vendorAccepted ||
        OrderState.preparing =>
          true,
        _ => false,
      };

  /// Cancelling during preparation costs the customer half (PDF §8).
  String? get cancelWarning => _state == OrderState.preparing
      ? 'The vendor has already started cooking. You will be refunded 50%.'
      : null;
}
