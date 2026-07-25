/// Real network transport and persistent token storage.
///
/// Kept in a separate library from `besonc_api.dart` so the core client
/// stays dependency-free and testable; only the apps import this.
library;

import 'dart:convert';
import 'dart:io';

import 'besonc_api.dart';

/// dart:io HttpClient rather than package:http — one less dependency, and we
/// need per-request timeouts and connection reuse anyway.
class IoHttpTransport implements HttpTransport {
  IoHttpTransport({HttpClient? client, this.userAgent = 'Besonc/0.1 (Android)'})
      : _client = client ?? HttpClient() {
    // Ghanaian mobile data is high-latency; a stingy connect timeout turns a
    // slow-but-working network into a hard failure.
    _client.connectionTimeout = const Duration(seconds: 15);
    _client.idleTimeout = const Duration(seconds: 30);
  }

  final HttpClient _client;
  final String userAgent;

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    final uri = Uri.parse(url);
    final req = await _client.openUrl(method, uri);

    headers.forEach(req.headers.set);
    req.headers.set('user-agent', userAgent);
    // Without this dart:io adds `content-length: 0` AND keeps content-type,
    // which used to trip the backend's empty-JSON-body rejection.
    if (body != null) {
      final bytes = utf8.encode(body);
      req.headers.set('content-length', bytes.length.toString());
      req.add(bytes);
    } else {
      req.headers.removeAll('content-type');
    }

    final res = await req.close().timeout(timeout ?? const Duration(seconds: 20));
    final text = await res.transform(utf8.decoder).join();

    final out = <String, String>{};
    res.headers.forEach((k, v) => out[k] = v.join(','));
    return HttpResponse(res.statusCode, text, out);
  }

  void close() => _client.close(force: true);
}

/* ------------------------------------------------------------------ */
/* Token persistence                                                   */
/* ------------------------------------------------------------------ */

/// Reads and writes the two tokens, whatever the platform store is.
///
/// Production should back this with the Android Keystore / iOS Keychain via
/// flutter_secure_storage. That plugin cannot be exercised in this
/// environment, so the port is defined here and the file-backed
/// implementation below is the default until the plugin is wired in CI.
abstract class SecureStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// File-backed store. NOT secure on a rooted device — see [SecureStore].
class FileSecureStore implements SecureStore {
  FileSecureStore(this.directory);
  final String directory;

  File _f(String key) => File('$directory/$key');

  @override
  Future<String?> read(String key) async {
    final f = _f(key);
    return await f.exists() ? f.readAsString() : null;
  }

  @override
  Future<void> write(String key, String value) async {
    final f = _f(key);
    await f.parent.create(recursive: true);
    await f.writeAsString(value, flush: true);
  }

  @override
  Future<void> delete(String key) async {
    final f = _f(key);
    if (await f.exists()) await f.delete();
  }
}

/// A [TokenStore] that survives app restarts.
///
/// Caches in memory so the hot path (every request reads the access token)
/// never touches the disk.
class PersistentTokenStore implements TokenStore {
  PersistentTokenStore(this._store);

  final SecureStore _store;
  String? _access;
  String? _refresh;
  bool _loaded = false;

  Future<void> _load() async {
    if (_loaded) return;
    _access = await _store.read('besonc.access');
    _refresh = await _store.read('besonc.refresh');
    _loaded = true;
  }

  @override
  Future<String?> accessToken() async {
    await _load();
    return _access;
  }

  @override
  Future<String?> refreshToken() async {
    await _load();
    return _refresh;
  }

  @override
  Future<void> save({required String access, required String refresh}) async {
    _access = access;
    _refresh = refresh;
    _loaded = true;
    await _store.write('besonc.access', access);
    await _store.write('besonc.refresh', refresh);
  }

  @override
  Future<void> clear() async {
    _access = null;
    _refresh = null;
    _loaded = true;
    await _store.delete('besonc.access');
    await _store.delete('besonc.refresh');
  }
}
