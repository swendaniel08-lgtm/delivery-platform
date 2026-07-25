/// End-to-end boot of the customer app against a scripted transport.
///
/// This is the test that would have caught "the app is not runnable": it
/// drives the real composition — auth gate, session restore, home controller,
/// BFF payload parsing — with only the socket replaced.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_customer/app/app.dart';
import 'package:besonc_customer/app/environment.dart';
import 'package:besonc_customer/state/home_controller.dart';
import 'package:besonc_customer/screens/home_screen.dart';

/// Routes by path so the order of calls does not have to be guessed.
class RouteTransport implements HttpTransport {
  RouteTransport(this.routes);

  /// path suffix → (status, body)
  final Map<String, (int, Map<String, dynamic>)> routes;
  final List<String> calls = [];
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
    if (failWith != null) throw failWith!;
    for (final entry in routes.entries) {
      if (path.endsWith(entry.key)) {
        return HttpResponse(entry.value.$1, jsonEncode(entry.value.$2));
      }
    }
    return HttpResponse(404, jsonEncode({'title': 'no route for $path'}));
  }
}

final _homePayload = <String, dynamic>{
  'deliveringTo': {
    'label': 'Home',
    'areaName': 'Osu',
    'landmark': 'behind the MTN mast',
    'lat': 5.5560,
    'lng': -0.1821,
  },
  'services': [
    {'key': 'food', 'label': 'Food', 'enabled': true},
    {'key': 'groceries', 'label': 'Groceries', 'enabled': true},
  ],
  'activeOrder': {
    'id': 'o-1',
    'humanRef': 'BSC-4821',
    'state': 'preparing',
    'service': 'food',
    'totalPesewas': '8150',
    'storeName': 'Auntie Muni Waakye',
  },
  'popularNearYou': [
    {
      'id': 's-1', 'name': 'Auntie Muni Waakye', 'rating': 4.7,
      'prepEstimate': '25-35 min', 'deliveryFee': 'GHS 8.00', 'isOpen': true,
    },
  ],
  'topRated': [
    {
      'id': 's-2', 'name': 'Chez Clarisse', 'rating': 4.9,
      'prepEstimate': '30-40 min', 'deliveryFee': 'GHS 10.00', 'isOpen': false,
    },
  ],
  'newOnBesonc': <dynamic>[],
};

AppDependencies buildDeps(RouteTransport transport) {
  late final AuthController auth;
  final api = BesoncApi(
    baseUrl: 'http://test',
    transport: transport,
    maxRetries: 0,
    backoff: (_) => Duration.zero,
    onAuthLost: () => auth.onSessionExpired(),
  );
  auth = AuthController(api: api, role: AuthRole.customer);
  return AppDependencies(
    api: api,
    auth: auth,
    environment: const BesoncEnvironment(
      apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', name: 'test',
    ),
  );
}

void main() {
  /// 360dp wide: the size that actually finds overflow bugs.
  Future<void> pumpApp(WidgetTester t, AppDependencies deps) async {
    await t.binding.setSurfaceSize(const Size(360, 800));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(BesoncCustomerApp(deps: deps));
    await t.pumpAndSettle();
  }

  group('cold start', () {
    testWidgets('with no saved session the app opens on sign-in', (t) async {
      final transport = RouteTransport({});
      final deps = buildDeps(transport);

      await pumpApp(t, deps);

      expect(find.byKey(const Key('phone-field')), findsOneWidget);
      expect(transport.calls, isEmpty,
          reason: 'no token means no pointless /users/me on every launch');
    });

    testWidgets('a saved session goes straight to home', (t) async {
      final transport = RouteTransport({
        '/api/users/me': (200, {
          'id': 'u1', 'phone': '+233244123456', 'role': 'customer', 'firstName': 'Ama',
        }),
        '/api/customer/home': (200, _homePayload),
      });
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');

      await pumpApp(t, deps);

      expect(find.byKey(const Key('phone-field')), findsNothing);
      expect(find.text('Auntie Muni Waakye'), findsWidgets);
      expect(transport.calls, contains('GET /api/customer/home'));
    });

    testWidgets('a new account is asked for a name before seeing home', (t) async {
      final transport = RouteTransport({
        // No firstName → needsProfile.
        '/api/users/me': (200, {
          'id': 'u1', 'phone': '+233244123456', 'role': 'customer',
        }),
        '/api/customer/home': (200, _homePayload),
      });
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');

      await pumpApp(t, deps);

      expect(find.byKey(const Key('first-name-field')), findsOneWidget);
      expect(find.text('Auntie Muni Waakye'), findsNothing);
    });
  });

  group('sign-in journey', () {
    testWidgets('phone → code → home, all the way through', (t) async {
      final transport = RouteTransport({
        '/api/auth/otp/request': (201, {
          'phone': '+233244123456', 'expiresInSeconds': 300,
        }),
        '/api/auth/otp/verify': (201, {
          'isNewUser': false,
          'user': {
            'id': 'u1', 'phone': '+233244123456', 'role': 'customer', 'firstName': 'Ama',
          },
          'tokens': {'accessToken': 'a', 'refreshToken': 'r'},
        }),
        '/api/customer/home': (200, _homePayload),
      });
      final deps = buildDeps(transport);

      await pumpApp(t, deps);

      await t.enterText(find.byKey(const Key('phone-field')), '0244123456');
      await t.tap(find.byKey(const Key('phone-continue')));
      await t.pumpAndSettle();

      expect(find.byKey(const Key('code-field')), findsOneWidget);

      await t.enterText(find.byKey(const Key('code-field')), '123456');
      await t.pumpAndSettle();

      expect(find.text('Auntie Muni Waakye'), findsWidgets);
      // The tokens really were persisted, so the next launch skips all this.
      expect(await deps.api.tokens.refreshToken(), 'r');
    });
  });

  group('home controller', () {
    test('parses the BFF payload into the view model', () async {
      final transport = RouteTransport({'/api/customer/home': (200, _homePayload)});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final home = HomeController(api: api);

      await home.load();

      expect(home.state, LoadState.ready);
      expect(home.data!.address!.landmark, 'behind the MTN mast');
      expect(home.data!.activeOrder!.humanRef, 'BSC-4821');
      expect(home.data!.popular.single.name, 'Auntie Muni Waakye');
      expect(home.data!.topRated.single.isOpen, isFalse);
    });

    test('a first-load failure shows the error screen', () async {
      final transport = RouteTransport({});
      transport.failWith = const _Offline();
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final home = HomeController(api: api);

      await home.load();

      expect(home.state, LoadState.failed);
      expect(home.errorMessage, contains('No connection'));
    });

    test('a failed REFRESH keeps the content already on screen', () async {
      final transport = RouteTransport({'/api/customer/home': (200, _homePayload)});
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final home = HomeController(api: api);
      await home.load();
      expect(home.state, LoadState.ready);

      transport.failWith = const _Offline();
      await home.load();

      expect(home.state, LoadState.ready,
          reason: 'a dropped refresh must not blank a screen the user is reading');
      expect(home.data!.popular.single.name, 'Auntie Muni Waakye');
      expect(home.errorMessage, isNotNull);
    });

    test('a 500 from the BFF is reported, not swallowed', () async {
      final transport = RouteTransport({
        '/api/customer/home': (500, {'title': 'Internal Server Error'}),
      });
      final api = BesoncApi(baseUrl: 'http://t', transport: transport, maxRetries: 0);
      final home = HomeController(api: api);

      await home.load();

      expect(home.state, LoadState.failed);
      expect(home.errorMessage, isNotNull);
    });
  });

  group('session loss mid-use', () {
    testWidgets('an expired refresh token returns the user to sign-in', (t) async {
      final transport = RouteTransport({
        '/api/users/me': (200, {
          'id': 'u1', 'phone': '+233244123456', 'role': 'customer', 'firstName': 'Ama',
        }),
        '/api/customer/home': (200, _homePayload),
      });
      final deps = buildDeps(transport);
      await deps.api.tokens.save(access: 'a', refresh: 'r');
      await pumpApp(t, deps);
      expect(find.text('Auntie Muni Waakye'), findsWidgets);

      deps.auth.onSessionExpired();
      await t.pumpAndSettle();

      expect(find.byKey(const Key('phone-field')), findsOneWidget);
      expect(find.textContaining('session expired'), findsOneWidget);
    });
  });
}

class _Offline implements Exception {
  const _Offline();
  @override
  String toString() => 'offline';
}
