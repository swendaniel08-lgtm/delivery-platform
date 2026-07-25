/// Shared phone + OTP authentication for all three Besonc apps.
///
/// There are no passwords (MASTER_PLAN §3.1). The whole flow is:
///   enter phone → receive SMS → enter 6 digits → signed in.
///
/// Everything here is transport-agnostic: it talks to a [BesoncApi] and
/// exposes a [ChangeNotifier], so it can be driven in a widget test without
/// a socket, a real SMS, or a running backend.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:besonc_api/besonc_api.dart';

/// Which app is asking. The backend stamps this onto the account it creates,
/// and refuses to sign a customer's number in as a rider.
enum AuthRole { customer, vendorOwner, rider }

extension AuthRoleWire on AuthRole {
  String get wire => switch (this) {
        AuthRole.customer => 'customer',
        AuthRole.vendorOwner => 'vendor_owner',
        AuthRole.rider => 'rider',
      };
}

/// Where the user is in the sign-in journey.
enum AuthStage {
  /// Deciding whether a stored session is still good.
  restoring,

  /// Not signed in; showing the phone field.
  phoneEntry,

  /// A code has been sent; showing the six boxes.
  codeEntry,

  /// Signed in.
  authenticated,
}

class AuthUser {
  const AuthUser({
    required this.id,
    required this.phone,
    required this.role,
    this.firstName,
    this.lastName,
  });

  final String id;
  final String phone;
  final String role;
  final String? firstName;
  final String? lastName;

  /// True until the user has told us their name — the app routes new users
  /// to the profile screen rather than dropping them on an anonymous home.
  bool get needsProfile => (firstName ?? '').trim().isEmpty;

  String get displayName {
    final n = '${firstName ?? ''} ${lastName ?? ''}'.trim();
    return n.isEmpty ? phone : n;
  }

  factory AuthUser.fromJson(Map<String, dynamic> j) => AuthUser(
        id: j['id'] as String,
        phone: j['phone'] as String,
        role: j['role'] as String? ?? 'customer',
        firstName: j['firstName'] as String?,
        lastName: j['lastName'] as String?,
      );
}

/* ------------------------------------------------------------------ */
/* Phone formatting                                                    */
/* ------------------------------------------------------------------ */

/// Normalise the ways Ghanaians actually type their number.
///
/// Accepts `0244123456`, `244123456`, `+233244123456`, `233 244 123 456`
/// and anything with spaces or dashes. Returns E.164, or null if it cannot
/// possibly be a Ghanaian mobile number.
///
/// This runs on the client purely to give instant feedback; identity-svc
/// normalises again and its answer is the one that counts.
String? normaliseGhanaPhone(String input) {
  final digits = input.replaceAll(RegExp(r'[^\d+]'), '');
  var body = digits;
  if (body.startsWith('+233')) {
    body = body.substring(4);
  } else if (body.startsWith('233')) {
    body = body.substring(3);
  } else if (body.startsWith('0')) {
    body = body.substring(1);
  }
  // A Ghanaian mobile subscriber number is 9 digits and starts 2, 3, 5 or 6.
  if (!RegExp(r'^[2356]\d{8}$').hasMatch(body)) return null;
  return '+233$body';
}

/// Pretty form for display: +233 24 412 3456.
String formatGhanaPhone(String e164) {
  final m = RegExp(r'^\+233(\d{2})(\d{3})(\d{4})$').firstMatch(e164);
  if (m == null) return e164;
  return '+233 ${m.group(1)} ${m.group(2)} ${m.group(3)}';
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

class AuthController extends ChangeNotifier {
  AuthController({
    required BesoncApi api,
    required this.role,
    DateTime Function()? clock,
  })  : _api = api,
        _now = clock ?? DateTime.now;

  final BesoncApi _api;
  final AuthRole role;
  final DateTime Function() _now;

  AuthStage _stage = AuthStage.restoring;
  AuthUser? _user;
  String? _pendingPhone;
  String? _error;
  Map<String, List<String>>? _fieldErrors;
  bool _busy = false;
  DateTime? _resendAvailableAt;

  /// Set when the backend runs in test mode; lets integration runs skip SMS.
  String? debugCode;

  AuthStage get stage => _stage;
  AuthUser? get user => _user;
  String? get pendingPhone => _pendingPhone;
  String? get error => _error;
  Map<String, List<String>>? get fieldErrors => _fieldErrors;
  bool get busy => _busy;
  bool get isAuthenticated => _stage == AuthStage.authenticated;

  /// Seconds until "Resend code" becomes tappable again. 0 means now.
  int get resendInSeconds {
    final at = _resendAvailableAt;
    if (at == null) return 0;
    final s = at.difference(_now()).inSeconds;
    return s > 0 ? s : 0;
  }

  bool get canResend => resendInSeconds == 0 && !_busy;

  void _set({
    AuthStage? stage,
    bool? busy,
    String? error,
    Map<String, List<String>>? fieldErrors,
    bool clearError = false,
  }) {
    if (stage != null) _stage = stage;
    if (busy != null) _busy = busy;
    if (clearError) {
      _error = null;
      _fieldErrors = null;
    }
    if (error != null) _error = error;
    if (fieldErrors != null) _fieldErrors = fieldErrors;
    notifyListeners();
  }

  /// Called once at startup. If a refresh token survives from last launch we
  /// try to use it; a network failure here must NOT sign the user out, so a
  /// failed restore that is not an explicit 401 leaves them at phone entry
  /// with their tokens intact for the next attempt.
  Future<void> restore() async {
    _set(stage: AuthStage.restoring, clearError: true);
    final refresh = await _api.tokens.refreshToken();
    if (refresh == null) {
      _set(stage: AuthStage.phoneEntry);
      return;
    }
    try {
      final me = await _api.get('/api/users/me');
      _user = AuthUser.fromJson(me);
      _set(stage: AuthStage.authenticated);
    } on ApiException catch (e) {
      if (e.isUnauthorised) await _api.tokens.clear();
      _set(stage: AuthStage.phoneEntry);
    } on NetworkException {
      _set(stage: AuthStage.phoneEntry);
    }
  }

  /// Step 1: ask for a code.
  Future<bool> requestCode(String rawPhone) async {
    final phone = normaliseGhanaPhone(rawPhone);
    if (phone == null) {
      _set(stage: AuthStage.phoneEntry, fieldErrors: {
        'phone': ['Enter a valid Ghana mobile number, e.g. 024 412 3456'],
      });
      return false;
    }

    _set(busy: true, clearError: true);
    try {
      final res = await _api.post('/api/auth/otp/request', body: {'phone': phone});
      _pendingPhone = phone;
      debugCode = res['debugCode'] as String?;
      // Mirror the server's 60s resend cooldown so the button is disabled
      // BEFORE the user can earn a 429 they do not understand.
      _resendAvailableAt = _now().add(const Duration(seconds: 60));
      _set(stage: AuthStage.codeEntry, busy: false);
      return true;
    } on ApiException catch (e) {
      if (e.isRateLimited) {
        // Honour Retry-After: this is the cooldown, not a failure.
        _pendingPhone = phone;
        _resendAvailableAt =
            _now().add(Duration(seconds: e.retryAfterSeconds ?? 60));
        _set(stage: AuthStage.codeEntry, busy: false, error: e.message);
        return true;
      }
      _set(stage: AuthStage.phoneEntry, busy: false,
          error: e.message, fieldErrors: e.errors);
      return false;
    } on NetworkException catch (e) {
      // Never strand the user on the splash: if the very first call of the
      // session fails we are still in `restoring`, and they would stare at a
      // spinner forever.
      _set(stage: AuthStage.phoneEntry, busy: false, error: e.message);
      return false;
    }
  }

  /// Step 2: submit the six digits.
  Future<bool> verifyCode(String code) async {
    final phone = _pendingPhone;
    if (phone == null) {
      _set(stage: AuthStage.phoneEntry, error: 'Request a new code');
      return false;
    }
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      _set(fieldErrors: {'code': ['Enter the 6-digit code']});
      return false;
    }

    _set(busy: true, clearError: true);
    try {
      final res = await _api.post('/api/auth/otp/verify', body: {
        'phone': phone,
        'code': code,
        'role': role.wire,
      });
      final tokens = res['tokens'] as Map<String, dynamic>;
      await _api.tokens.save(
        access: tokens['accessToken'] as String,
        refresh: tokens['refreshToken'] as String,
      );
      _user = AuthUser.fromJson(res['user'] as Map<String, dynamic>);
      _pendingPhone = null;
      debugCode = null;
      _resendAvailableAt = null;
      _set(stage: AuthStage.authenticated, busy: false);
      return true;
    } on ApiException catch (e) {
      // 409 means the number belongs to a different role — telling the user
      // to "try again" would be cruel, so surface the real reason.
      _set(busy: false, error: e.message, fieldErrors: e.errors);
      return false;
    } on NetworkException catch (e) {
      _set(busy: false, error: e.message);
      return false;
    }
  }

  Future<bool> resendCode() async {
    if (!canResend) return false;
    final phone = _pendingPhone;
    if (phone == null) return false;
    return requestCode(phone);
  }

  /// Back to the phone field, e.g. the user mistyped their number.
  void changeNumber() {
    _pendingPhone = null;
    debugCode = null;
    _resendAvailableAt = null;
    _set(stage: AuthStage.phoneEntry, clearError: true);
  }

  /// Save the name we ask new users for immediately after their first login.
  Future<bool> saveProfile({required String firstName, String? lastName}) async {
    if (firstName.trim().isEmpty) {
      _set(fieldErrors: {'firstName': ['Tell us what to call you']});
      return false;
    }
    _set(busy: true, clearError: true);
    try {
      final res = await _api.patch('/api/users/me', body: {
        'firstName': firstName.trim(),
        if (lastName != null && lastName.trim().isNotEmpty) 'lastName': lastName.trim(),
      });
      _user = AuthUser.fromJson(res);
      _set(busy: false);
      return true;
    } on ApiException catch (e) {
      _set(busy: false, error: e.message, fieldErrors: e.errors);
      return false;
    } on NetworkException catch (e) {
      _set(busy: false, error: e.message);
      return false;
    }
  }

  Future<void> signOut() async {
    // Tell the server so the refresh family is revoked, but never block the
    // user in the app if that call fails — clear locally regardless.
    try {
      await _api.post('/api/auth/logout');
    } catch (_) {/* best effort */}
    await _api.tokens.clear();
    _user = null;
    _pendingPhone = null;
    _set(stage: AuthStage.phoneEntry, clearError: true);
  }

  /// Wired to [BesoncApi.onAuthLost]: the refresh token was rejected while
  /// the user was mid-session.
  void onSessionExpired() {
    _user = null;
    _set(stage: AuthStage.phoneEntry, error: 'Your session expired. Please sign in again.');
  }
}
