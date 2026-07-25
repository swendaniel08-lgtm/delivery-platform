/// The vendor app shell.
///
/// A vendor's phone sits on a counter in a busy kitchen. The whole app is
/// really one screen — the order queue — and the only thing that matters is
/// that a new order is impossible to miss and one tap away from accepted.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_auth/auth_screens.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../screens/dashboard_screen.dart';
import '../state/order_queue_controller.dart';
import 'environment.dart';

class VendorDependencies {
  VendorDependencies({
    required this.api,
    required this.auth,
    required this.environment,
  });

  final BesoncApi api;
  final AuthController auth;
  final VendorEnvironment environment;

  void dispose() => auth.dispose();
}

class VendorScope extends InheritedWidget {
  const VendorScope({super.key, required this.deps, required super.child});

  final VendorDependencies deps;

  static VendorDependencies of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<VendorScope>();
    assert(scope != null, 'VendorScope is missing above this widget');
    return scope!.deps;
  }

  @override
  bool updateShouldNotify(VendorScope oldWidget) => oldWidget.deps != deps;
}

/* ------------------------------------------------------------------ */

class BesoncVendorApp extends StatefulWidget {
  const BesoncVendorApp({super.key, required this.deps});

  final VendorDependencies deps;

  @override
  State<BesoncVendorApp> createState() => _BesoncVendorAppState();
}

class _BesoncVendorAppState extends State<BesoncVendorApp> {
  @override
  void initState() {
    super.initState();
    widget.deps.auth.restore();
  }

  @override
  Widget build(BuildContext context) {
    return VendorScope(
      deps: widget.deps,
      child: MaterialApp(
        title: 'Besonc Vendor',
        debugShowCheckedModeBanner: false,
        theme: besoncTheme(),
        home: AuthGate(
          auth: widget.deps.auth,
          tagline: 'Run your kitchen on Besonc.',
          child: const VendorRoot(),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

/// Owns the queue, the poll timer and the API calls behind each button.
class VendorQueueCoordinator {
  VendorQueueCoordinator({required BesoncApi api, OrderQueueController? controller})
      : _api = api,
        controller = controller ?? OrderQueueController();

  final BesoncApi _api;
  final OrderQueueController controller;

  String storeName = '';
  double rating = 0;
  Timer? _timer;

  /// Poll rather than socket for the queue.
  ///
  /// A missed WebSocket frame means a missed order, which for a vendor is a
  /// lost sale and an angry customer. A 10-second poll is cheap, survives
  /// the app being backgrounded, and cannot silently desynchronise.
  static const pollInterval = Duration(seconds: 10);

  Future<void> start() async {
    await refresh();
    _timer ??= Timer.periodic(pollInterval, (_) => refresh());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> refresh() async {
    try {
      final json = await _api.get('/api/vendor/queue');
      storeName = json['storeName'] as String? ?? storeName;
      rating = (json['rating'] as num?)?.toDouble() ?? rating;
      controller.setOpen(json['isOpen'] as bool? ?? true);
      controller.setOrders(
        (json['orders'] as List<dynamic>? ?? [])
            .map((o) => VendorOrder.fromJson(o as Map<String, dynamic>))
            .toList(),
      );
    } on ApiException catch (e) {
      controller.setError(e.message);
    } on NetworkException catch (e) {
      controller.setError(e.message);
    }
  }

  /// Perform a queue action. The order is marked pending first so a
  /// double-tap on a laggy network cannot accept the same order twice.
  Future<void> act(String orderId, VendorAction action) async {
    if (action == VendorAction.none || action == VendorAction.awaitingRider) return;
    if (controller.isPending(orderId)) return;

    controller.markPending(orderId);
    try {
      await _api.post(
        '/api/vendor/orders/$orderId/${_pathFor(action)}',
        // A stable key across retries: the server collapses duplicates even
        // if the response to the first attempt never arrived.
        idempotencyKey: 'vendor:$orderId:${_pathFor(action)}',
      );
      await refresh();
    } on ApiException catch (e) {
      controller.setError(e.message);
    } on NetworkException catch (e) {
      controller.setError(e.message);
    } finally {
      controller.clearPending(orderId);
    }
  }

  Future<void> toggleOpen(bool isOpen) async {
    final previous = controller.isOpen;
    // Optimistic: the switch must feel instant when the gas runs out.
    controller.setOpen(isOpen);
    try {
      await _api.patch('/api/vendor/store/open', body: {'isOpen': isOpen});
    } catch (_) {
      controller.setOpen(previous);
      controller.setError('Could not update your store status');
    }
  }

  static String _pathFor(VendorAction a) => switch (a) {
        VendorAction.accept => 'accept',
        VendorAction.reject => 'reject',
        VendorAction.markPreparing => 'preparing',
        VendorAction.markReady => 'ready',
        _ => '',
      };

  void dispose() {
    stop();
    controller.dispose();
  }
}

class VendorRoot extends StatefulWidget {
  const VendorRoot({super.key});

  @override
  State<VendorRoot> createState() => _VendorRootState();
}

class _VendorRootState extends State<VendorRoot> {
  VendorQueueCoordinator? _queue;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_queue == null) {
      _queue = VendorQueueCoordinator(api: VendorScope.of(context).api);
      _queue!.start();
    }
  }

  @override
  void dispose() {
    _queue?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final deps = VendorScope.of(context);
    final queue = _queue!;

    return AnimatedBuilder(
      animation: queue.controller,
      builder: (context, _) {
        final user = deps.auth.user;
        if (user != null && user.needsProfile) {
          return ProfileSetupScreen(auth: deps.auth, onDone: () => setState(() {}));
        }

        return DashboardScreen(
          controller: queue.controller,
          storeName: queue.storeName.isEmpty ? 'Your store' : queue.storeName,
          rating: queue.rating,
          onAct: queue.act,
          onToggleOpen: queue.toggleOpen,
          onRetry: queue.refresh,
        );
      },
    );
  }
}
