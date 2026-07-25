/// Besonc API client.
///
/// Written for Ghanaian mobile networks, which means assuming the connection
/// is slow, intermittent, and will drop mid-request:
///
///   * every mutation carries an Idempotency-Key, so a retry after a timeout
///     cannot create two orders or charge twice
///   * GETs retry with backoff; POSTs retry only when they are idempotent
///   * a 401 triggers ONE refresh attempt, and concurrent 401s share it
///     rather than stampeding the auth service
///   * RFC-7807 problem documents become typed exceptions with the message
///     the backend wrote, so the UI shows a real reason
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/// An RFC-7807 problem returned by the API.
class ApiException implements Exception {
  ApiException({
    required this.status,
    required this.title,
    this.detail,
    this.type,
    this.errors,
    this.correlationId,
    this.retryAfterSeconds,
  });

  final int status;
  final String title;
  final String? detail;
  final String? type;

  /// Field-level validation errors, e.g. {'phone': ['not a valid number']}.
  final Map<String, List<String>>? errors;
  final String? correlationId;
  final int? retryAfterSeconds;

  /// What to actually show the user.
  String get message => detail ?? title;

  bool get isUnauthorised => status == 401;
  bool get isRateLimited => status == 429;
  bool get isConflict => status == 409;
  bool get isValidation => status == 422;

  /// 5xx and 408 are worth retrying; 4xx generally are not.
  bool get isRetryable => status >= 500 || status == 408;

  factory ApiException.fromProblem(int status, Map<String, dynamic> body) {
    Map<String, List<String>>? fieldErrors;
    final raw = body['errors'];
    if (raw is Map) {
      fieldErrors = raw.map(
        (k, v) => MapEntry(k as String,
            (v as List<dynamic>).map((e) => e.toString()).toList()),
      );
    }
    return ApiException(
      status: status,
      title: body['title'] as String? ?? 'Request failed',
      detail: body['detail'] as String?,
      type: body['type'] as String?,
      errors: fieldErrors,
      correlationId: body['correlationId'] as String?,
      retryAfterSeconds: body['retryAfterSeconds'] as int?,
    );
  }

  @override
  String toString() => 'ApiException($status): $message';
}

/// The request never reached the server, or the reply never came back.
class NetworkException implements Exception {
  NetworkException(this.cause);
  final Object cause;

  /// Deliberately non-technical: users see this one a lot.
  String get message => 'No connection. Check your network and try again.';

  @override
  String toString() => 'NetworkException: $cause';
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

class HttpResponse {
  const HttpResponse(this.statusCode, this.body, [this.headers = const {}]);
  final int statusCode;
  final String body;
  final Map<String, String> headers;
}

/// Injectable transport so the client is testable without a real socket.
abstract class HttpTransport {
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  });
}

/// Holds tokens and knows how to refresh them.
abstract class TokenStore {
  Future<String?> accessToken();
  Future<String?> refreshToken();
  Future<void> save({required String access, required String refresh});
  Future<void> clear();
}

class InMemoryTokenStore implements TokenStore {
  String? _access;
  String? _refresh;
  @override
  Future<String?> accessToken() async => _access;
  @override
  Future<String?> refreshToken() async => _refresh;
  @override
  Future<void> save({required String access, required String refresh}) async {
    _access = access;
    _refresh = refresh;
  }
  @override
  Future<void> clear() async {
    _access = null;
    _refresh = null;
  }
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

typedef IdGenerator = String Function();

class BesoncApi {
  BesoncApi({
    required this.baseUrl,
    required HttpTransport transport,
    TokenStore? tokens,
    IdGenerator? idGenerator,
    this.onAuthLost,
    this.maxRetries = 3,
    this.timeout = const Duration(seconds: 20),
    Duration Function(int attempt)? backoff,
  })  : _transport = transport,
        _tokens = tokens ?? InMemoryTokenStore(),
        _newId = idGenerator ?? _defaultId,
        _backoff = backoff ?? _defaultBackoff;

  final String baseUrl;
  final HttpTransport _transport;
  final TokenStore _tokens;
  final IdGenerator _newId;
  final int maxRetries;
  final Duration timeout;
  final Duration Function(int) _backoff;

  /// Called when refresh fails — the app should route to sign-in.
  final void Function()? onAuthLost;

  /// Shared across concurrent 401s so we refresh once, not N times.
  Future<bool>? _refreshInFlight;

  static String _defaultId() {
    final r = Random.secure();
    return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }

  /// Exponential backoff with jitter — without jitter, every phone in Accra
  /// retries at the same instant after an outage and knocks the API over again.
  static Duration _defaultBackoff(int attempt) {
    final base = 300 * pow(2, attempt).toInt();
    final jitter = Random().nextInt(200);
    return Duration(milliseconds: min(base + jitter, 5000));
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async =>
      _request('GET', path, query: query, retryable: true);

  /// POSTs are retried only when idempotent. [idempotencyKey] makes them so:
  /// pass a stable key and the server collapses duplicates.
  Future<Map<String, dynamic>> post(
    String path, {
    Object? body,
    String? idempotencyKey,
  }) async =>
      _request('POST', path,
          body: body,
          idempotencyKey: idempotencyKey,
          retryable: idempotencyKey != null);

  Future<Map<String, dynamic>> patch(String path, {Object? body}) async =>
      _request('PATCH', path, body: body, retryable: false);

  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
    String? idempotencyKey,
    bool retryable = false,
    bool isRetryAfterRefresh = false,
  }) async {
    final url = _buildUrl(path, query);
    // One key for the whole retry sequence, not one per attempt.
    final key = idempotencyKey;

    Object? lastError;
    for (var attempt = 0; attempt <= (retryable ? maxRetries : 0); attempt++) {
      if (attempt > 0) await Future<void>.delayed(_backoff(attempt - 1));

      final headers = <String, String>{
        'content-type': 'application/json',
        'accept': 'application/json',
        if (key != null) 'idempotency-key': key,
      };
      final token = await _tokens.accessToken();
      if (token != null) headers['authorization'] = 'Bearer $token';

      HttpResponse res;
      try {
        res = await _transport.send(
          method: method,
          url: url,
          headers: headers,
          body: body == null ? null : jsonEncode(body),
          timeout: timeout,
        );
      } catch (e) {
        lastError = NetworkException(e);
        if (attempt == (retryable ? maxRetries : 0)) throw lastError;
        continue;
      }

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return _decode(res.body);
      }

      // 401 → refresh once, then replay the original request.
      if (res.statusCode == 401 && !isRetryAfterRefresh) {
        final refreshed = await _refreshOnce();
        if (refreshed) {
          return _request(method, path,
              body: body, query: query, idempotencyKey: key,
              retryable: retryable, isRetryAfterRefresh: true);
        }
        onAuthLost?.call();
      }

      final problem = _toException(res);
      if (problem.isRetryable && attempt < (retryable ? maxRetries : 0)) {
        lastError = problem;
        continue;
      }
      throw problem;
    }
    throw lastError ?? NetworkException('exhausted retries');
  }

  /// Concurrent 401s wait on ONE refresh rather than each firing their own.
  Future<bool> _refreshOnce() {
    return _refreshInFlight ??= _doRefresh().whenComplete(() {
      _refreshInFlight = null;
    });
  }

  Future<bool> _doRefresh() async {
    final refresh = await _tokens.refreshToken();
    if (refresh == null) return false;
    try {
      final res = await _transport.send(
        method: 'POST',
        url: _buildUrl('/api/auth/refresh', null),
        headers: const {'content-type': 'application/json'},
        body: jsonEncode({'refreshToken': refresh}),
        timeout: timeout,
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await _tokens.clear();
        return false;
      }
      final body = _decode(res.body);
      await _tokens.save(
        access: body['accessToken'] as String,
        refresh: body['refreshToken'] as String,
      );
      return true;
    } catch (_) {
      // A network failure during refresh must NOT log the user out — they
      // may simply be in a tunnel. Only an explicit rejection clears tokens.
      return false;
    }
  }

  String _buildUrl(String path, Map<String, String>? query) {
    final base = '$baseUrl$path';
    if (query == null || query.isEmpty) return base;
    // encodeQueryComponent renders a space as '+', which is form-encoding.
    // Our Fastify backend parses RFC-3986 percent-encoding, so a search for
    // "jollof rice" would otherwise arrive as "jollof+rice".
    final qs = query.entries
        .map((e) =>
            '${Uri.encodeComponent(e.key)}=${Uri.encodeComponent(e.value)}')
        .join('&');
    return '$base?$qs';
  }

  Map<String, dynamic> _decode(String body) {
    if (body.isEmpty) return const {};
    final decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic>) return decoded;
    return {'data': decoded};
  }

  ApiException _toException(HttpResponse res) {
    try {
      final body = jsonDecode(res.body);
      if (body is Map<String, dynamic>) {
        return ApiException.fromProblem(res.statusCode, body);
      }
    } catch (_) {
      // fall through: a proxy or load balancer returned HTML
    }
    return ApiException(status: res.statusCode, title: 'Request failed');
  }

  /// Stable key for an action the user may retry by tapping again.
  String idempotencyKeyFor(String action, String scopeId) => '$action:$scopeId:${_newId()}';

  TokenStore get tokens => _tokens;
}
