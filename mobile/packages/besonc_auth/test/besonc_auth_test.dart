/// Auth controller + screens.
///
/// A fake transport stands in for the network, so these exercise the real
/// [BesoncApi] retry/refresh machinery against scripted HTTP responses.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_auth/auth_screens.dart';

/// Scripted transport: queue a reply per (method, path-suffix).
class FakeTransport implements HttpTransport {
  final List<HttpResponse> queue = [];
  final List<String> calls = [];
  Object? throwOnce;

  void reply(int status, Map<String, dynamic> body) =>
      queue.add(HttpResponse(status, jsonEncode(body)));

  @override
  Future<HttpResponse> send({
    required String method,
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration? timeout,
  }) async {
    calls.add('$method ${Uri.parse(url).path}${body == null ? '' : ' $body'}');
    if (throwOnce != null) {
      final e = throwOnce;
      throwOnce = null;
      throw e!;
    }
    if (queue.isEmpty) return HttpResponse(500, '{"title":"no scripted reply"}');
    return queue.removeAt(0);
  }
}

class _Harness {
  _Harness({DateTime Function()? clock}) {
    transport = FakeTransport();
    api = BesoncApi(
      baseUrl: 'http://test',
      transport: transport,
      maxRetries: 0,
      backoff: (_) => Duration.zero,
    );
    auth = AuthController(api: api, role: AuthRole.customer, clock: clock);
  }
  late final FakeTransport transport;
  late final BesoncApi api;
  late final AuthController auth;
}

void main() {
  group('phone normalisation', () {
    test('accepts the four ways Ghanaians write a number', () {
      const want = '+233244123456';
      expect(normaliseGhanaPhone('0244123456'), want);
      expect(normaliseGhanaPhone('244123456'), want);
      expect(normaliseGhanaPhone('+233244123456'), want);
      expect(normaliseGhanaPhone('233 244 123 456'), want);
    });

    test('tolerates spaces, dashes and brackets from a contacts paste', () {
      expect(normaliseGhanaPhone('024-412 3456'), '+233244123456');
      expect(normaliseGhanaPhone('  0244 123 456  '), '+233244123456');
    });

    test('rejects numbers that cannot be Ghanaian mobiles', () {
      expect(normaliseGhanaPhone('12345'), isNull);
      expect(normaliseGhanaPhone('0144123456'), isNull, reason: 'no such prefix');
      expect(normaliseGhanaPhone('024412345'), isNull, reason: 'one digit short');
      expect(normaliseGhanaPhone('02441234567'), isNull, reason: 'one digit long');
      expect(normaliseGhanaPhone(''), isNull);
    });

    test('all four live network prefixes are accepted', () {
      for (final p in ['20', '24', '25', '26', '27', '54', '55', '59', '32', '39']) {
        expect(normaliseGhanaPhone('0${p}1234567'), isNotNull, reason: p);
      }
    });

    test('display formatting groups the digits', () {
      expect(formatGhanaPhone('+233244123456'), '+233 24 412 3456');
      expect(formatGhanaPhone('garbage'), 'garbage', reason: 'never throws in the UI');
    });
  });

  group('request code', () {
    test('a valid number moves to code entry', () async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});

      final ok = await h.auth.requestCode('024 412 3456');
      expect(ok, isTrue);
      expect(h.auth.stage, AuthStage.codeEntry);
      expect(h.auth.pendingPhone, '+233244123456');
      expect(h.transport.calls.single, contains('"phone":"+233244123456"'),
          reason: 'the server receives E.164, not what the user typed');
    });

    test('an invalid number never reaches the network', () async {
      final h = _Harness();
      final ok = await h.auth.requestCode('12345');
      expect(ok, isFalse);
      expect(h.transport.calls, isEmpty, reason: 'no wasted SMS spend or round trip');
      expect(h.auth.fieldErrors!['phone']!.first, contains('valid Ghana mobile'));
      expect(h.auth.stage, AuthStage.phoneEntry);
    });

    test('a 429 still advances to code entry — a code was already sent', () async {
      final h = _Harness();
      h.transport.reply(429, {
        'title': 'Too Many Requests',
        'detail': 'Please wait 45s before requesting another code',
        'retryAfterSeconds': 45,
      });

      final ok = await h.auth.requestCode('0244123456');
      expect(ok, isTrue, reason: 'the earlier code is still valid; let them type it');
      expect(h.auth.stage, AuthStage.codeEntry);
      expect(h.auth.resendInSeconds, closeTo(45, 1));
    });

    test('a 422 from the server surfaces as a field error', () async {
      final h = _Harness();
      h.transport.reply(422, {
        'title': 'Validation Failed',
        'errors': {'phone': ['This number is blocked']},
      });
      final ok = await h.auth.requestCode('0244123456');
      expect(ok, isFalse);
      expect(h.auth.fieldErrors!['phone']!.first, 'This number is blocked');
    });

    test('a network failure gives a human message, not a stack trace', () async {
      final h = _Harness();
      h.transport.throwOnce = const SocketishError();
      final ok = await h.auth.requestCode('0244123456');
      expect(ok, isFalse);
      expect(h.auth.error, contains('No connection'));
      expect(h.auth.stage, AuthStage.phoneEntry);
    });

    test('the resend cooldown mirrors the server so no 429 is ever earned', () async {
      var now = DateTime(2026, 7, 25, 12, 0, 0);
      final h = _Harness(clock: () => now);
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');

      expect(h.auth.canResend, isFalse);
      expect(h.auth.resendInSeconds, 60);

      now = now.add(const Duration(seconds: 59));
      expect(h.auth.canResend, isFalse);

      now = now.add(const Duration(seconds: 2));
      expect(h.auth.canResend, isTrue);
      expect(h.auth.resendInSeconds, 0);
    });

    test('resend is a no-op while cooling down', () async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');
      h.transport.calls.clear();

      expect(await h.auth.resendCode(), isFalse);
      expect(h.transport.calls, isEmpty);
    });
  });

  group('verify code', () {
    Future<_Harness> atCodeEntry() async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');
      return h;
    }

    test('a correct code authenticates and stores both tokens', () async {
      final h = await atCodeEntry();
      h.transport.reply(201, {
        'isNewUser': true,
        'user': {'id': 'u1', 'phone': '+233244123456', 'role': 'customer'},
        'tokens': {'accessToken': 'acc', 'refreshToken': 'ref'},
      });

      final ok = await h.auth.verifyCode('123456');
      expect(ok, isTrue);
      expect(h.auth.stage, AuthStage.authenticated);
      expect(h.auth.user!.id, 'u1');
      expect(await h.api.tokens.accessToken(), 'acc');
      expect(await h.api.tokens.refreshToken(), 'ref');
    });

    test('the app is told to collect a name for a brand-new account', () async {
      final h = await atCodeEntry();
      h.transport.reply(201, {
        'isNewUser': true,
        'user': {'id': 'u1', 'phone': '+233244123456', 'role': 'customer'},
        'tokens': {'accessToken': 'a', 'refreshToken': 'r'},
      });
      await h.auth.verifyCode('123456');
      expect(h.auth.user!.needsProfile, isTrue);
      expect(h.auth.user!.displayName, '+233244123456',
          reason: 'fall back to the phone rather than showing a blank name');
    });

    test('a short code never reaches the network', () async {
      final h = await atCodeEntry();
      h.transport.calls.clear();
      expect(await h.auth.verifyCode('123'), isFalse);
      expect(h.transport.calls, isEmpty);
      expect(h.auth.fieldErrors!['code']!.first, contains('6-digit'));
    });

    test('a wrong code keeps the user on the code screen with the count', () async {
      final h = await atCodeEntry();
      h.transport.reply(422, {
        'title': 'Validation Failed',
        'errors': {'code': ['Incorrect code. 4 attempt(s) remaining.']},
      });
      expect(await h.auth.verifyCode('000000'), isFalse);
      expect(h.auth.stage, AuthStage.codeEntry, reason: 'do not throw them back to the start');
      expect(h.auth.fieldErrors!['code']!.first, contains('4 attempt'));
    });

    test('a role conflict shows the real reason', () async {
      final h = await atCodeEntry();
      h.transport.reply(409, {
        'title': 'Conflict',
        'detail': 'This number is already registered as a rider',
      });
      expect(await h.auth.verifyCode('123456'), isFalse);
      expect(h.auth.error, contains('already registered as a rider'));
    });

    test('verifying without a pending phone bounces back to phone entry', () async {
      final h = _Harness();
      expect(await h.auth.verifyCode('123456'), isFalse);
      expect(h.auth.stage, AuthStage.phoneEntry);
    });

    test('changing the number clears the pending state', () async {
      final h = await atCodeEntry();
      h.auth.changeNumber();
      expect(h.auth.stage, AuthStage.phoneEntry);
      expect(h.auth.pendingPhone, isNull);
      expect(h.auth.error, isNull);
    });
  });

  group('session restore', () {
    test('no stored token goes straight to phone entry', () async {
      final h = _Harness();
      await h.auth.restore();
      expect(h.auth.stage, AuthStage.phoneEntry);
      expect(h.transport.calls, isEmpty);
    });

    test('a good stored session restores the user without an SMS', () async {
      final h = _Harness();
      await h.api.tokens.save(access: 'a', refresh: 'r');
      h.transport.reply(200, {
        'id': 'u1', 'phone': '+233244123456', 'role': 'customer', 'firstName': 'Ama',
      });

      await h.auth.restore();
      expect(h.auth.stage, AuthStage.authenticated);
      expect(h.auth.user!.displayName, 'Ama');
      expect(h.auth.user!.needsProfile, isFalse);
    });

    test('a rejected session clears the tokens', () async {
      final h = _Harness();
      await h.api.tokens.save(access: 'a', refresh: 'r');
      // /users/me 401 → the client tries a refresh, which also fails.
      h.transport.reply(401, {'title': 'Unauthorized'});
      h.transport.reply(401, {'title': 'Unauthorized'});
      h.transport.reply(401, {'title': 'Unauthorized'});

      await h.auth.restore();
      expect(h.auth.stage, AuthStage.phoneEntry);
      expect(await h.api.tokens.refreshToken(), isNull);
    });

    test('a network failure on restore does NOT log the user out', () async {
      final h = _Harness();
      await h.api.tokens.save(access: 'a', refresh: 'r');
      h.transport.throwOnce = const SocketishError();

      await h.auth.restore();
      expect(h.auth.stage, AuthStage.phoneEntry);
      expect(await h.api.tokens.refreshToken(), 'r',
          reason: 'a tunnel is not a logout — the next launch should retry');
    });
  });

  group('sign out', () {
    test('clears tokens even when the server call fails', () async {
      final h = _Harness();
      await h.api.tokens.save(access: 'a', refresh: 'r');
      h.transport.throwOnce = const SocketishError();

      await h.auth.signOut();
      expect(await h.api.tokens.accessToken(), isNull);
      expect(h.auth.stage, AuthStage.phoneEntry);
      expect(h.auth.user, isNull);
    });

    test('an expired session mid-use routes back to sign-in with a reason', () {
      final h = _Harness();
      h.auth.onSessionExpired();
      expect(h.auth.stage, AuthStage.phoneEntry);
      expect(h.auth.error, contains('expired'));
    });
  });

  group('profile setup', () {
    test('saves the name and updates the user', () async {
      final h = _Harness();
      h.transport.reply(200, {
        'id': 'u1', 'phone': '+233244123456', 'role': 'customer',
        'firstName': 'Kofi', 'lastName': 'Boateng',
      });
      expect(await h.auth.saveProfile(firstName: 'Kofi', lastName: 'Boateng'), isTrue);
      expect(h.auth.user!.displayName, 'Kofi Boateng');
    });

    test('an empty name never reaches the network', () async {
      final h = _Harness();
      expect(await h.auth.saveProfile(firstName: '   '), isFalse);
      expect(h.transport.calls, isEmpty);
      expect(h.auth.fieldErrors!['firstName'], isNotNull);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Widgets                                                           */
  /* ---------------------------------------------------------------- */

  group('screens', () {
    /// 360x740 is the commonest Android size in Ghana; overflow bugs only
    /// appear at this width, never at the 800x600 test default.
    Future<void> pump(WidgetTester t, Widget child) async {
      await t.binding.setSurfaceSize(const Size(360, 740));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(MaterialApp(home: child));
      await t.pump();
    }

    testWidgets('the gate shows a splash while restoring', (t) async {
      final h = _Harness();
      await pump(t, AuthGate(auth: h.auth, child: const Text('inside')));
      expect(find.byKey(const Key('auth-splash')), findsOneWidget);
      expect(find.text('inside'), findsNothing);
    });

    testWidgets('the gate reveals the app once authenticated', (t) async {
      final h = _Harness();
      await h.api.tokens.save(access: 'a', refresh: 'r');
      h.transport.reply(200, {'id': 'u1', 'phone': '+233244123456', 'role': 'customer'});

      await pump(t, AuthGate(auth: h.auth, child: const Text('inside')));
      await h.auth.restore();
      await t.pump();

      expect(find.text('inside'), findsOneWidget);
    });

    testWidgets('typing a number and tapping Continue requests a code', (t) async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await pump(t, AuthGate(auth: h.auth, child: const Text('inside')));
      await h.auth.restore();
      await t.pump();

      await t.enterText(find.byKey(const Key('phone-field')), '0244123456');
      await t.tap(find.byKey(const Key('phone-continue')));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('code-field')), findsOneWidget);
      expect(find.byKey(const Key('code-destination')), findsOneWidget);
      expect(find.text('Sent to +233 24 412 3456'), findsOneWidget);
    });

    testWidgets('the phone screen lays out on a 360dp phone without overflow',
        (t) async {
      final h = _Harness();
      await pump(t, PhoneEntryScreen(auth: h.auth));
      expect(tester_hasOverflow(t), isFalse);
      expect(find.byKey(const Key('auth-wordmark')), findsOneWidget);
    });

    testWidgets('an invalid number shows an inline error and stays put', (t) async {
      final h = _Harness();
      await pump(t, PhoneEntryScreen(auth: h.auth));

      await t.enterText(find.byKey(const Key('phone-field')), '123');
      await t.tap(find.byKey(const Key('phone-continue')));
      await t.pumpAndSettle();

      expect(find.textContaining('valid Ghana mobile'), findsOneWidget);
      expect(find.byKey(const Key('phone-field')), findsOneWidget);
    });

    testWidgets('the code screen auto-submits on the sixth digit', (t) async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');
      h.transport.reply(201, {
        'isNewUser': false,
        'user': {'id': 'u1', 'phone': '+233244123456', 'role': 'customer', 'firstName': 'Ama'},
        'tokens': {'accessToken': 'a', 'refreshToken': 'r'},
      });

      await pump(t, AuthGate(auth: h.auth, child: const Text('inside')));
      await t.enterText(find.byKey(const Key('code-field')), '123456');
      await t.pumpAndSettle();

      expect(find.text('inside'), findsOneWidget,
          reason: 'no extra tap needed after typing the code');
    });

    testWidgets('resend is disabled with a countdown while cooling down', (t) async {
      var now = DateTime(2026, 7, 25, 12);
      final h = _Harness(clock: () => now);
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');

      await pump(t, CodeEntryScreen(auth: h.auth));
      expect(find.text('Resend code in 60s'), findsOneWidget);

      final button = t.widget<TextButton>(find.byKey(const Key('code-resend')));
      expect(button.onPressed, isNull);
    });

    testWidgets('the back arrow returns to phone entry', (t) async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');

      await pump(t, AuthGate(auth: h.auth, child: const Text('inside')));
      await t.tap(find.byKey(const Key('code-back')));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('phone-field')), findsOneWidget);
    });

    testWidgets('profile setup saves and calls back', (t) async {
      final h = _Harness();
      h.transport.reply(200, {
        'id': 'u1', 'phone': '+233244123456', 'role': 'customer', 'firstName': 'Kofi',
      });
      var done = false;
      await pump(t, ProfileSetupScreen(auth: h.auth, onDone: () => done = true));

      await t.enterText(find.byKey(const Key('first-name-field')), 'Kofi');
      await t.tap(find.byKey(const Key('profile-save')));
      await t.pumpAndSettle();

      expect(done, isTrue);
    });

    testWidgets('the code screen fits a 360dp phone with the keyboard up', (t) async {
      final h = _Harness();
      h.transport.reply(201, {'phone': '+233244123456', 'expiresInSeconds': 300});
      await h.auth.requestCode('0244123456');

      await t.binding.setSurfaceSize(const Size(360, 740));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(MaterialApp(
        home: MediaQuery(
          // A typical Android keyboard eats ~300dp.
          data: const MediaQueryData(viewInsets: EdgeInsets.only(bottom: 300)),
          child: CodeEntryScreen(auth: h.auth),
        ),
      ));
      await t.pump();

      expect(tester_hasOverflow(t), isFalse);
      expect(find.byKey(const Key('code-verify')), findsOneWidget);
    });
  });
}

/// True if Flutter reported a layout overflow during the last pump.
bool tester_hasOverflow(WidgetTester t) {
  final errors = t.takeException();
  if (errors == null) return false;
  return errors.toString().contains('overflowed');
}

/// Stand-in for a dart:io SocketException, which is unavailable in a
/// package that must also compile for web.
class SocketishError implements Exception {
  const SocketishError();
  @override
  String toString() => 'Connection refused';
}
