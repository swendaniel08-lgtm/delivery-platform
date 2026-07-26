/// Keeps a [TrackingController] fed with real positions.
///
/// The socket is the primary source and polling is the fallback, because on
/// Ghanaian mobile data the WebSocket WILL drop — riding through a dead
/// spot, switching cell towers, the OS suspending a backgrounded app.
///
/// The rule this file exists to enforce: **a dropped socket must degrade to
/// slower updates, never to a frozen screen.** A customer watching a dot
/// that stopped moving has no way to tell "the rider is at a traffic light"
/// from "the app died".
library;

import 'dart:async';

import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_models/besonc_models.dart';

import 'tracking_controller.dart';

/// A live position feed. Implemented by a real WebSocket in the app and by
/// a fake in tests, so reconnection logic is verifiable without a server.
abstract class PositionStream {
  /// Emits until [close] is called or the connection drops.
  Stream<Map<String, dynamic>> connect(String orderId, String token);
  Future<void> close();
}

/// Drives one order's tracking for as long as the screen is open.
class TrackingSession {
  TrackingSession({
    required BesoncApi api,
    required this.controller,
    PositionStream? stream,
    Duration pollInterval = const Duration(seconds: 10),
    Duration Function(int attempt)? backoff,
  })  : _api = api,
        _stream = stream,
        _pollInterval = pollInterval,
        _backoff = backoff ?? _defaultBackoff;

  final BesoncApi _api;
  final TrackingController controller;
  final PositionStream? _stream;
  final Duration _pollInterval;
  final Duration Function(int) _backoff;

  StreamSubscription<Map<String, dynamic>>? _sub;
  Timer? _poll;
  Timer? _reconnect;
  int _attempt = 0;
  bool _stopped = false;

  /// Exponential backoff with a ceiling.
  ///
  /// Without a ceiling a rider in a long dead spot reconnects once an hour;
  /// without backoff, every phone in Accra retries in lockstep after an
  /// outage and knocks the socket server over again.
  static Duration _defaultBackoff(int attempt) {
    final seconds = [1, 2, 5, 10, 20, 30][attempt.clamp(0, 5)];
    return Duration(seconds: seconds);
  }

  Future<void> start(String token) async {
    _stopped = false;
    // Poll immediately so the map has something to draw before the socket
    // finishes its handshake.
    await _pollOnce();
    _startPolling();
    _openSocket(token);
  }

  void _openSocket(String token) {
    final stream = _stream;
    if (stream == null) {
      // No socket transport configured: polling alone is a slower but
      // entirely correct experience.
      controller.onConnected();
      return;
    }

    _sub?.cancel();
    _sub = stream.connect(controller.orderId, token).listen(
      (frame) {
        _attempt = 0;
        controller.onConnected();
        _applyFrame(frame);
      },
      onError: (_) => _scheduleReconnect(token),
      onDone: () => _scheduleReconnect(token),
      cancelOnError: true,
    );
  }

  void _scheduleReconnect(String token) {
    if (_stopped) return;
    // DEGRADED, not offline: polling is still running, so the screen keeps
    // updating while the socket is down.
    controller.onDisconnected();

    _reconnect?.cancel();
    _reconnect = Timer(_backoff(_attempt), () {
      if (_stopped) return;
      _attempt += 1;
      _openSocket(token);
    });
  }

  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(_pollInterval, (_) => _pollOnce());
  }

  /// One REST read. Also the only source when no socket is available.
  Future<void> _pollOnce() async {
    if (_stopped) return;
    try {
      final json = await _api.get(
        '/api/customer/orders/${controller.orderId}/tracking',
      );

      final pos = json['position'] as Map<String, dynamic>?;
      if (pos != null) {
        controller.onPosition(
          LatLng(
            (pos['lat'] as num).toDouble(),
            (pos['lng'] as num).toDouble(),
          ),
          etaSeconds: json['etaSeconds'] as int?,
        );
      }
      final state = json['state'] as String?;
      if (state != null) controller.onStateChanged(OrderState.fromWire(state));
    } on NetworkException {
      // A dropped poll on mobile data is routine. The controller's
      // staleness clock is already running, so the badge will say
      // "Last seen 40s ago" without us doing anything.
    } catch (_) {
      // Same: never let a failed poll blank a screen the customer is
      // actively watching.
    }
  }

  void _applyFrame(Map<String, dynamic> frame) {
    final pos = frame['position'] as Map<String, dynamic>?;
    if (pos != null) {
      controller.onPosition(
        LatLng((pos['lat'] as num).toDouble(), (pos['lng'] as num).toDouble()),
        etaSeconds: frame['etaSeconds'] as int?,
      );
    }
    final state = frame['state'] as String?;
    if (state != null) {
      final next = OrderState.fromWire(state);
      controller.onStateChanged(next);
      // The order is finished. Keep the screen readable but stop consuming
      // the customer's data plan on a delivery that already happened.
      if (next.isTerminal) stop();
    }
  }

  Future<void> stop() async {
    _stopped = true;
    _poll?.cancel();
    _reconnect?.cancel();
    await _sub?.cancel();
    _sub = null;
    await _stream?.close();
  }
}
