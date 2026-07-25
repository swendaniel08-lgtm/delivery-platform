/// Proof-of-delivery capture and upload.
///
/// This is on the critical path of EVERY delivery: order-svc rejects
/// `rider_deliver` without a photoUrl, so a rider with no working upload
/// cannot finish a job at all. Before this existed the app had a "take
/// proof" button that set a local flag and uploaded nothing — every
/// completion would have failed with a 422.
///
/// The flow is a three-step presigned upload:
///   1. ask the BFF for somewhere to put it
///   2. PUT the bytes straight to object storage
///   3. hand the object key back with the delivery event
///
/// Bytes never pass through our services. On Ghanaian mobile data,
/// proxying a 3MB photo would double the upload time for no benefit.
library;


import 'package:flutter/foundation.dart';
import 'package:besonc_api/besonc_api.dart';

/// Takes a photo. Implemented by the camera plugin in the app, and by a
/// fake in tests — the upload logic must be testable without a camera.
abstract class PhotoSource {
  /// Returns JPEG bytes, or null if the rider backed out of the camera.
  Future<Uint8List?> capture();
}

/// Uploads raw bytes to a presigned URL.
abstract class BlobUploader {
  Future<void> put({
    required String url,
    required Uint8List bytes,
    required Map<String, String> headers,
  });
}

enum ProofStage { idle, capturing, uploading, ready, failed }

/// What the rider sees while the photo is being dealt with.
class ProofCaptureController extends ChangeNotifier {
  ProofCaptureController({
    required BesoncApi api,
    required PhotoSource camera,
    required BlobUploader uploader,
  })  : _api = api,
        _camera = camera,
        _uploader = uploader;

  final BesoncApi _api;
  final PhotoSource _camera;
  final BlobUploader _uploader;

  ProofStage _stage = ProofStage.idle;
  String? _objectKey;
  String? _error;
  Uint8List? _bytes;

  ProofStage get stage => _stage;

  /// The key to send with `rider_deliver`. Null until the upload succeeds.
  String? get objectKey => _objectKey;
  String? get error => _error;
  Uint8List? get preview => _bytes;

  bool get hasProof => _objectKey != null;
  bool get busy =>
      _stage == ProofStage.capturing || _stage == ProofStage.uploading;

  /// The server's cap for a delivery photo (media policy).
  static const int maxBytes = 3_000_000;

  void _set(ProofStage stage, {String? error}) {
    _stage = stage;
    _error = error;
    notifyListeners();
  }

  /// Capture and upload. Safe to call again after a failure.
  Future<bool> capture(String orderId) async {
    if (busy) return false;

    _set(ProofStage.capturing);
    Uint8List? bytes;
    try {
      bytes = await _camera.capture();
    } catch (e) {
      _set(ProofStage.failed, error: 'Could not open the camera');
      return false;
    }

    if (bytes == null) {
      // The rider cancelled. Not an error — just back to where we were.
      _set(_objectKey == null ? ProofStage.idle : ProofStage.ready);
      return false;
    }

    if (bytes.length > maxBytes) {
      // Caught here rather than after a slow upload, so the rider is not
      // waiting on 3G only to be told the file was too big.
      _set(ProofStage.failed,
          error: 'That photo is too large. Try again with less detail.');
      return false;
    }

    _bytes = bytes;
    return _upload(orderId, bytes);
  }

  /// Retry the upload with the photo already taken.
  ///
  /// Separate from [capture] on purpose: a failed upload on a bad signal
  /// must not make the rider photograph the doorstep a second time — they
  /// may already have left it.
  Future<bool> retryUpload(String orderId) async {
    final bytes = _bytes;
    if (bytes == null) return capture(orderId);
    return _upload(orderId, bytes);
  }

  Future<bool> _upload(String orderId, Uint8List bytes) async {
    _set(ProofStage.uploading);
    try {
      final grant = await _api.post('/api/rider/proof-uploads', body: {
        'orderId': orderId,
        'contentType': 'image/jpeg',
        'sizeBytes': bytes.length,
      });

      final url = grant['uploadUrl'] as String?;
      final key = grant['objectKey'] as String?;
      if (url == null || key == null) {
        _set(ProofStage.failed, error: 'Could not prepare the upload');
        return false;
      }

      await _uploader.put(
        url: url,
        bytes: bytes,
        headers: {
          'content-type': 'image/jpeg',
          ...?(grant['requiredHeaders'] as Map?)?.cast<String, String>(),
        },
      );

      _objectKey = key;
      _set(ProofStage.ready);
      return true;
    } on ApiException catch (e) {
      _set(ProofStage.failed, error: e.message);
      return false;
    } on NetworkException catch (e) {
      _set(ProofStage.failed, error: e.message);
      return false;
    } catch (e) {
      // Storage returned something unexpected. The rider needs a next step,
      // not a stack trace.
      _set(ProofStage.failed, error: 'Upload failed. Tap to try again.');
      return false;
    }
  }

  /// Clear between deliveries.
  ///
  /// Carrying a photo into the next job would attach the wrong doorstep to
  /// a delivery dispute.
  void reset() {
    _objectKey = null;
    _bytes = null;
    _set(ProofStage.idle);
  }
}
