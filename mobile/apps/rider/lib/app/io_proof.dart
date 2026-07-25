/// Real camera and blob-upload implementations.
///
/// Kept apart from `proof_capture.dart` so the upload logic stays testable
/// without a camera or a socket — the state machine there is what decides
/// whether a rider can finish a delivery, and it must be verifiable.
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

import '../state/proof_capture.dart';

/// The handset camera.
class CameraPhotoSource implements PhotoSource {
  CameraPhotoSource({ImagePicker? picker}) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  @override
  Future<Uint8List?> capture() async {
    // Compressed on the DEVICE, before the upload. A modern phone camera
    // produces 4-8MB per shot; over Ghanaian mobile data that is a minute
    // of a rider's time per delivery, and it exceeds the 3MB server cap.
    final shot = await _picker.pickImage(
      source: ImageSource.camera,
      imageQuality: 70,
      maxWidth: 1600,
    );
    if (shot == null) return null;   // rider backed out
    return shot.readAsBytes();
  }
}

/// PUTs bytes to a presigned URL.
class IoBlobUploader implements BlobUploader {
  IoBlobUploader({HttpClient? client}) : _client = client ?? HttpClient() {
    // Generous: this is a photo on a motorbike, on 3G, possibly moving.
    _client.connectionTimeout = const Duration(seconds: 20);
  }

  final HttpClient _client;

  @override
  Future<void> put({
    required String url,
    required Uint8List bytes,
    required Map<String, String> headers,
  }) async {
    final req = await _client.putUrl(Uri.parse(url));
    headers.forEach(req.headers.set);
    // Presigned policies check content-length; omitting it is a 403 from
    // storage that reads like a permissions problem but is not.
    req.headers.set('content-length', bytes.length.toString());
    req.add(bytes);

    final res = await req.close().timeout(const Duration(minutes: 2));
    await res.drain<void>();

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw HttpException('storage rejected the upload (${res.statusCode})');
    }
  }

  void close() => _client.close(force: true);
}
