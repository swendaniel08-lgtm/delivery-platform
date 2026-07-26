/// The rider app shell.
///
/// This app is used one-handed, at a traffic light, in sunlight, by someone
/// who should be watching the road. Two consequences shape the code:
///
///   • Offers are polled aggressively while online and idle, because a
///     missed offer is lost income and riders notice immediately.
///   • Position reporting follows the server's advertised cadence (5s on a
///     delivery, 30s idle) rather than a fixed timer — GPS is the single
///     biggest drain on a phone that has to last a whole shift.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_chat/besonc_chat.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_auth/auth_screens.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../screens/rider_home_screen.dart';
import '../state/proof_capture.dart';
import '../state/rider_controller.dart';
import 'environment.dart';
import 'io_proof.dart';

class RiderDependencies {
  RiderDependencies({
    required this.api,
    required this.auth,
    required this.environment,
    PhotoSource? camera,
    BlobUploader? uploader,
  })  : camera = camera ?? CameraPhotoSource(),
        uploader = uploader ?? IoBlobUploader();

  final BesoncApi api;
  final AuthController auth;
  final RiderEnvironment environment;

  /// Injectable so the delivery-completion path can be tested without a
  /// camera. It is the single most important flow in this app.
  final PhotoSource camera;
  final BlobUploader uploader;

  void dispose() => auth.dispose();
}

class RiderScope extends InheritedWidget {
  const RiderScope({super.key, required this.deps, required super.child});

  final RiderDependencies deps;

  static RiderDependencies of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<RiderScope>();
    assert(scope != null, 'RiderScope is missing above this widget');
    return scope!.deps;
  }

  @override
  bool updateShouldNotify(RiderScope oldWidget) => oldWidget.deps != deps;
}

/* ------------------------------------------------------------------ */

class BesoncRiderApp extends StatefulWidget {
  const BesoncRiderApp({super.key, required this.deps});

  final RiderDependencies deps;

  @override
  State<BesoncRiderApp> createState() => _BesoncRiderAppState();
}

class _BesoncRiderAppState extends State<BesoncRiderApp> {
  @override
  void initState() {
    super.initState();
    widget.deps.auth.restore();
  }

  @override
  Widget build(BuildContext context) {
    return RiderScope(
      deps: widget.deps,
      child: MaterialApp(
        title: 'Besonc Rider',
        debugShowCheckedModeBanner: false,
        theme: besoncTheme(),
        home: AuthGate(
          auth: widget.deps.auth,
          tagline: 'Ride with Besonc.',
          child: const RiderRoot(),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

/// Owns the rider's session: polling, offers, and state transitions.
class RiderCoordinator {
  RiderCoordinator({required BesoncApi api, RiderController? controller})
      : _api = api,
        controller = controller ?? RiderController();

  final BesoncApi _api;
  final RiderController controller;

  /// The chat screen needs the same authenticated client the coordinator
  /// polls with; there is no second source of credentials.
  BesoncApi get api => _api;

  String riderName = '';
  Pesewas? walletBalance;
  Timer? _poll;

  /// Fast while idle and online — this is the "am I getting work?" loop.
  static const idlePoll = Duration(seconds: 5);

  Future<void> start() async {
    await refresh();
    _poll ??= Timer.periodic(idlePoll, (_) => refresh());
  }

  void stop() {
    _poll?.cancel();
    _poll = null;
  }

  Future<void> refresh() async {
    try {
      final json = await _api.get('/api/rider/state');
      riderName = json['riderName'] as String? ?? riderName;
      walletBalance = Pesewas.tryParse(json['walletBalancePesewas'] as String?);
      controller.setApproved(json['approved'] as bool? ?? false);

      final leg = json['activeLeg'] as Map<String, dynamic>?;
      controller.setLeg(leg == null ? null : ActiveLeg.fromJson(leg));

      final offer = json['offer'] as Map<String, dynamic>?;
      controller.setOffer(offer == null ? null : DispatchOffer.fromJson(offer));

      controller.setEarnings(
        today: Pesewas.parse(json['todayEarningsPesewas'] as String? ?? '0'),
        deliveries: json['todayDeliveries'] as int? ?? 0,
      );
      final oldest = json['oldestUnremittedAt'] as String?;
      controller.setCod(
        obligation: Pesewas.parse(json['codObligationPesewas'] as String? ?? '0'),
        oldestUnremitted: oldest == null ? null : DateTime.parse(oldest),
      );
    } catch (_) {
      // A dropped poll is normal on a motorbike. Staying quiet and retrying
      // in 5s is better than an error banner that flickers all shift.
    }
  }

  Future<void> toggleOnline(bool online) async {
    if (online && !controller.canGoOnline) return;
    controller.setOnline(online);
    try {
      await _api.post('/api/rider/${online ? 'online' : 'offline'}');
      await refresh();
    } catch (_) {
      controller.setOnline(!online);
    }
  }

  /// Accept an offer. Losing the race is a normal outcome, not an error:
  /// the server returns 200 with `won: false` and we simply clear the card.
  Future<void> acceptOffer() async {
    final offer = controller.offer;
    if (offer == null || !controller.canAcceptOffer) return;

    controller.setSubmitting(true);
    try {
      final res = await _api.post(
        '/api/rider/legs/${offer.legId}/accept',
        idempotencyKey: 'accept:${offer.legId}',
      );
      if (res['won'] != true) controller.setOffer(null);
      await refresh();
    } catch (_) {
      controller.setOffer(null);
    } finally {
      controller.setSubmitting(false);
    }
  }

  Future<void> declineOffer() async {
    final offer = controller.offer;
    if (offer == null) return;
    controller.setOffer(null);
    try {
      await _api.post('/api/rider/legs/${offer.legId}/decline');
    } catch (_) {/* the offer expires server-side anyway */}
  }

  /// Advance the leg's state machine. The event name comes from the
  /// controller so the app can never invent a transition the server rejects.
  Future<void> advance(String event, {String? photoUrl}) async {
    final leg = controller.leg;
    if (leg == null) return;

    controller.setSubmitting(true);
    try {
      await _api.post(
        '/api/rider/legs/${leg.legId}/events',
        body: {'event': event, if (photoUrl != null) 'photoUrl': photoUrl},
        // Stable across retries: a double-tap at a bad moment must not
        // deliver the order twice.
        idempotencyKey: 'leg:${leg.legId}:$event',
      );
      await refresh();
    } catch (_) {
      // Left to the next poll to reconcile.
    } finally {
      controller.setSubmitting(false);
    }
  }

  void dispose() {
    stop();
    controller.dispose();
  }
}

/// Per-delivery confirmations that live on THIS device for THIS leg.
///
/// Extracted from the widget so the reset rule can be tested directly: if a
/// previous delivery's cash confirmation ever carried into the next leg, a
/// rider could complete a COD job without collecting a pesewa.
class DeliveryConfirmations {
  String? _legId;
  bool hasProof = false;
  bool cashConfirmed = false;

  String? get legId => _legId;

  /// Call on every build with the current leg. Returns true if it reset.
  bool syncTo(String? currentLegId) {
    if (currentLegId == _legId) return false;
    _legId = currentLegId;
    hasProof = false;
    cashConfirmed = false;
    return true;
  }
}

class RiderRoot extends StatefulWidget {
  const RiderRoot({super.key});

  @override
  State<RiderRoot> createState() => _RiderRootState();
}

class _RiderRootState extends State<RiderRoot> {
  RiderCoordinator? _rider;

  /// Held here rather than in the controller: these are properties of THIS
  /// delivery attempt on THIS device, not of the rider's server-side state.
  final _confirmations = DeliveryConfirmations();
  ProofCaptureController? _proof;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_rider == null) {
      final deps = RiderScope.of(context);
      _rider = RiderCoordinator(api: deps.api);
      _rider!.start();
      _proof = ProofCaptureController(
        api: deps.api, camera: deps.camera, uploader: deps.uploader,
      );
    }
  }

  @override
  void dispose() {
    _rider?.dispose();
    _proof?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final deps = RiderScope.of(context);
    final rider = _rider!;

    return AnimatedBuilder(
      animation: rider.controller,
      builder: (context, _) {
        final user = deps.auth.user;
        if (user != null && user.needsProfile) {
          return ProfileSetupScreen(auth: deps.auth, onDone: () => setState(() {}));
        }

        // A new leg must start with proof and cash unconfirmed, or the
        // previous delivery's confirmation would carry over and let a rider
        // complete a job without collecting anything.
        if (_confirmations.syncTo(rider.controller.leg?.legId)) {
          // A new leg means a new doorstep. Carrying the previous photo
          // over would attach the wrong evidence to a delivery dispute.
          _proof?.reset();
        }

        return RiderHomeScreen(
          controller: rider.controller,
          riderName: rider.riderName.isEmpty
              ? (user?.displayName ?? 'Rider')
              : rider.riderName,
          walletBalance: rider.walletBalance,
          // Proof means UPLOADED, not "the button was tapped". order-svc
          // rejects rider_deliver without a real photoUrl, so anything less
          // would leave the rider unable to complete the job.
          hasProof: _proof?.hasProof ?? false,
          cashConfirmed: _confirmations.cashConfirmed,
          onToggleOnline: rider.toggleOnline,
          onAcceptOffer: rider.acceptOffer,
          onDeclineOffer: rider.declineOffer,
          onAdvance: (event) => rider.advance(
            event,
            // The delivery event carries the object key the upload returned.
            photoUrl: event == 'rider_deliver' ? _proof?.objectKey : null,
          ),
          onTakeProof: () => _capture(rider),
          onConfirmCash: () => setState(() => _confirmations.cashConfirmed = true),
          onRemit: () => _notYet(context, 'Cash remittance'),
          onNavigate: () => _notYet(context, 'Navigation hand-off'),
          onChat: () => _openChat(context, rider),
        );
      },
    );
  }

  /// Take (or re-take) the delivery photo.
  Future<void> _capture(RiderCoordinator rider) async {
    final orderId = rider.controller.leg?.orderId;
    final proof = _proof;
    if (orderId == null || proof == null) return;

    final ok = await proof.capture(orderId);
    if (!mounted) return;
    setState(() {});

    if (!ok && proof.error != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(proof.error!),
          action: SnackBarAction(
            label: 'Retry',
            // Retries the UPLOAD, not the photo — the rider may already
            // have walked away from the door.
            onPressed: () async {
              await proof.retryUpload(orderId);
              if (mounted) setState(() {});
            },
          ),
        ),
      );
    }
  }

  /// Message the customer about this job.
  void _openChat(BuildContext context, RiderCoordinator rider) {
    final orderId = rider.controller.leg?.orderId;
    // No active leg means nobody to message. The button is only rendered
    // inside the active-job card, so this is belt and braces.
    if (orderId == null) return;
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => RiderChatPage(api: rider.api, orderId: orderId),
    ));
  }

  void _notYet(BuildContext context, String what) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$what is coming in the next build')),
    );
  }
}


/// Chat with the customer for one job.
class RiderChatPage extends StatefulWidget {
  const RiderChatPage({super.key, required this.api, required this.orderId});

  final BesoncApi api;
  final String orderId;

  @override
  State<RiderChatPage> createState() => _RiderChatPageState();
}

class _RiderChatPageState extends State<RiderChatPage> {
  late final ChatController _chat = ChatController(
    orderId: widget.orderId,
    me: ChatParty.rider,
    transport: HttpChatTransport(
      api: widget.api,
      basePath: '/api/rider/jobs',
    ),
  );

  @override
  void initState() {
    super.initState();
    _chat.load();
    _chat.startPolling();
  }

  @override
  void dispose() {
    _chat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Customer')),
        body: ChatView(
          controller: _chat,
          emptyHint: 'Ask the customer for the gate, the floor, or a landmark.',
        ),
      );
}
