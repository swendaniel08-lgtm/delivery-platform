/// Proof of delivery — the thing that lets a rider finish a job.
///
/// order-svc rejects `rider_deliver` without a photoUrl. Before this
/// existed the app had a "take proof" button that set a local boolean and
/// uploaded nothing, so EVERY completion would have failed with a 422 and
/// no rider could have closed a single delivery.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_rider/app/app.dart';
import 'package:besonc_rider/app/environment.dart';
import 'package:besonc_rider/state/proof_capture.dart';

/// A camera that returns whatever the test wants.
class FakeCamera implements PhotoSource {
  FakeCamera({this.bytes, this.throws = false});
  Uint8List? bytes;
  bool throws;
  int captures = 0;

  @override
  Future<Uint8List?> capture() async {
    captures += 1;
    if (throws) throw Exception('camera unavailable');
    return bytes;
  }
}

class FakeUploader implements BlobUploader {
  final List<({String url, int size})> puts = [];
  Object? failWith;

  @override
  Future<void> put({
    required String url,
    required Uint8List bytes,
    required Map<String, String> headers,
  }) async {
    if (failWith != null) throw failWith!;
    puts.add((url: url, size: bytes.length));
  }
}

class RouteTransport implements HttpTransport {
  RouteTransport(this.routes);
  final Map<String, (int, Map<String, dynamic>)> routes;
  final List<String> calls = [];
  final List<String> bodies = [];
  Object? failWith;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    final path = Uri.parse(url).path;
    calls.add('$method $path');
    if (body != null) bodies.add(body);
    if (failWith != null) throw failWith!;

    var bestLen = -1;
    int? status;
    Map<String, dynamic>? payload;
    for (final e in routes.entries) {
      final parts = e.key.split(' ');
      if (parts[0] != method || !path.endsWith(parts[1])) continue;
      if (parts[1].length > bestLen) {
        bestLen = parts[1].length;
        status = e.value.$1;
        payload = e.value.$2;
      }
    }
    if (status != null) return HttpResponse(status, jsonEncode(payload));
    return HttpResponse(404, jsonEncode({'title': 'no route for $path'}));
  }
}

Uint8List photo([int size = 900_000]) => Uint8List(size);

final _grant = <String, dynamic>{
  'objectKey': 'proof_of_delivery/o-1/abc.jpg',
  'uploadUrl': 'https://storage.test/put/abc.jpg?sig=x',
  'requiredHeaders': {'content-type': 'image/jpeg'},
  'expiresInSeconds': 300,
  'maxBytes': 3000000,
};

void main() {
  ({
    ProofCaptureController proof,
    FakeCamera camera,
    FakeUploader uploader,
    RouteTransport transport,
  }) harness({Uint8List? bytes, bool cancelled = false}) {
    final transport = RouteTransport({
      'POST /api/rider/proof-uploads': (201, _grant),
    });
    // `cancelled` is explicit because `bytes: null` cannot be told apart
    // from "use the default photo" through a ?? fallback.
    final camera = FakeCamera(bytes: cancelled ? null : (bytes ?? photo()));
    final uploader = FakeUploader();
    return (
      proof: ProofCaptureController(
        api: BesoncApi(
          baseUrl: 'http://t', transport: transport, maxRetries: 0,
          backoff: (_) => Duration.zero,
        ),
        camera: camera,
        uploader: uploader,
      ),
      camera: camera,
      uploader: uploader,
      transport: transport,
    );
  }

  group('capture and upload', () {
    test('a photo is uploaded and yields an object key', () async {
      final h = harness();

      expect(await h.proof.capture('o-1'), isTrue);

      expect(h.proof.stage, ProofStage.ready);
      expect(h.proof.hasProof, isTrue);
      expect(h.proof.objectKey, 'proof_of_delivery/o-1/abc.jpg');
      expect(h.uploader.puts.single.url, contains('storage.test'),
          reason: 'bytes go straight to storage, never through our services');
      expect(h.transport.calls, contains('POST /api/rider/proof-uploads'));
    });

    test('the byte count is declared so storage can enforce the cap', () async {
      final h = harness(bytes: photo(1234));
      await h.proof.capture('o-1');
      expect(h.transport.bodies.single, contains('"sizeBytes":1234'));
    });

    test('NO PROOF UNTIL THE UPLOAD SUCCEEDS', () async {
      final h = harness();
      h.uploader.failWith = Exception('connection reset');

      expect(await h.proof.capture('o-1'), isFalse);
      expect(h.proof.hasProof, isFalse,
          reason: 'a local flag would let the rider tap Complete and get a 422');
      expect(h.proof.stage, ProofStage.failed);
      expect(h.proof.error, isNotNull);
    });

    test('a cancelled camera is not an error', () async {
      final h = harness(cancelled: true);

      expect(await h.proof.capture('o-1'), isFalse);
      expect(h.proof.stage, ProofStage.idle);
      expect(h.proof.error, isNull,
          reason: 'backing out of the camera is a normal thing to do');
    });

    test('an oversized photo is refused BEFORE the slow upload', () async {
      final h = harness(bytes: photo(ProofCaptureController.maxBytes + 1));

      expect(await h.proof.capture('o-1'), isFalse);
      expect(h.uploader.puts, isEmpty,
          reason: 'no point uploading 3MB over 3G only to be rejected');
      expect(h.proof.error, contains('too large'));
    });

    test('exactly the maximum is allowed', () async {
      final h = harness(bytes: photo(ProofCaptureController.maxBytes));
      expect(await h.proof.capture('o-1'), isTrue);
    });

    test('a camera failure is reported, not crashed on', () async {
      final h = harness();
      h.camera.throws = true;

      expect(await h.proof.capture('o-1'), isFalse);
      expect(h.proof.error, contains('camera'));
    });

    test('a rejected grant fails cleanly', () async {
      final h = harness();
      h.transport.routes['POST /api/rider/proof-uploads'] =
          (403, {'title': 'Forbidden', 'detail': 'Not your delivery'});

      expect(await h.proof.capture('o-1'), isFalse);
      expect(h.proof.error, contains('Not your delivery'));
      expect(h.uploader.puts, isEmpty);
    });

    test('two captures at once are ignored', () async {
      final h = harness();
      final first = h.proof.capture('o-1');
      final second = h.proof.capture('o-1');
      await Future.wait([first, second]);

      expect(h.camera.captures, 1,
          reason: 'a double tap must not open the camera twice');
    });
  });

  group('retry', () {
    test('RETRYING AN UPLOAD DOES NOT RE-OPEN THE CAMERA', () async {
      final h = harness();
      h.uploader.failWith = Exception('timeout');
      await h.proof.capture('o-1');
      expect(h.camera.captures, 1);

      h.uploader.failWith = null;
      expect(await h.proof.retryUpload('o-1'), isTrue);

      expect(h.camera.captures, 1,
          reason: 'the rider may already have walked away from the door');
      expect(h.proof.hasProof, isTrue);
    });

    test('retrying with no photo yet falls back to capturing one', () async {
      final h = harness();
      expect(await h.proof.retryUpload('o-1'), isTrue);
      expect(h.camera.captures, 1);
    });

    test('a network failure during the grant is retryable', () async {
      final h = harness();
      h.transport.failWith = const _Offline();
      await h.proof.capture('o-1');
      expect(h.proof.hasProof, isFalse);

      h.transport.failWith = null;
      expect(await h.proof.retryUpload('o-1'), isTrue);
    });
  });

  group('between deliveries', () {
    test('RESET CLEARS THE PHOTO', () async {
      final h = harness();
      await h.proof.capture('o-1');
      expect(h.proof.hasProof, isTrue);

      h.proof.reset();

      expect(h.proof.hasProof, isFalse);
      expect(h.proof.objectKey, isNull);
      expect(h.proof.preview, isNull,
          reason: 'the previous doorstep must not become evidence for the next');
    });
  });

  /* ---------------------------------------------------------------- */

  group('the rider app can complete a delivery', () {
    RiderDependencies deps(RouteTransport transport, FakeCamera camera,
        FakeUploader uploader) {
      late final AuthController auth;
      final api = BesoncApi(
        baseUrl: 'http://test', transport: transport, maxRetries: 0,
        backoff: (_) => Duration.zero,
        onAuthLost: () => auth.onSessionExpired(),
      );
      auth = AuthController(api: api, role: AuthRole.rider);
      return RiderDependencies(
        api: api, auth: auth, camera: camera, uploader: uploader,
        environment: const RiderEnvironment(
          apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', name: 'test',
        ),
      );
    }

    testWidgets('THE FULL COMPLETION: photo → upload → rider_deliver',
        (t) async {
      final transport = RouteTransport({
        'GET /api/users/me': (200, {
          'id': 'r1', 'phone': '+233244000002', 'role': 'rider',
          'firstName': 'Kofi', 'status': 'active',
        }),
        'GET /api/rider/state': (200, {
          'riderName': 'Kofi', 'approved': true,
          'walletBalancePesewas': '0', 'todayEarningsPesewas': '0',
          'todayDeliveries': 0, 'codObligationPesewas': '0',
          'activeLeg': {
            'legId': 'leg-1', 'orderId': 'o-1', 'humanRef': 'BSC-4821',
            'state': 'arrived', 'service': 'food',
            'pickup': {'lat': 5.6037, 'lng': -0.1870, 'label': 'Auntie Muni'},
            'dropoff': {'lat': 5.5560, 'lng': -0.1821, 'label': 'Osu'},
            'feePesewas': '800', 'isCod': false,
          },
        }),
        'POST /api/rider/proof-uploads': (201, _grant),
        'POST /api/rider/legs/leg-1/events': (201, {'state': 'delivered'}),
      });
      final camera = FakeCamera(bytes: photo());
      final uploader = FakeUploader();
      final d = deps(transport, camera, uploader);
      await d.api.tokens.save(access: 'a', refresh: 'r');

      await t.binding.setSurfaceSize(const Size(360, 800));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(BesoncRiderApp(deps: d));
      await t.pumpAndSettle();
      await t.pump(const Duration(milliseconds: 50));

      // Take the photo.
      await t.scrollUntilVisible(
        find.byKey(const Key('take-proof')), 120,
        scrollable: find.byType(Scrollable).first,
      );
      await t.tap(find.byKey(const Key('take-proof')));
      await t.pumpAndSettle();

      expect(camera.captures, 1, reason: 'the camera really opened');
      expect(uploader.puts, hasLength(1), reason: 'the photo really uploaded');

      // Complete the delivery: the event MUST carry the object key.
      await t.scrollUntilVisible(
        find.byKey(const Key('advance')), 120,
        scrollable: find.byType(Scrollable).first,
      );
      await t.tap(find.byKey(const Key('advance')));
      await t.pumpAndSettle();

      final deliverBody = transport.bodies.firstWhere(
        (b) => b.contains('rider_deliver'),
        orElse: () => '',
      );
      expect(deliverBody, contains('photoUrl'),
          reason: 'without this order-svc returns 422 and the job never closes');
      expect(deliverBody, contains('proof_of_delivery/o-1/abc.jpg'));
    });
  });
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
