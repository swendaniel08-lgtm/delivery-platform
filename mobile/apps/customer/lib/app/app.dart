/// The customer app shell: dependency wiring, routing and the auth gate.
///
/// Deliberately plain `Navigator` + a small InheritedWidget rather than a
/// routing package. The app has nine screens and one deep-link shape
/// (`besonc://order/<id>`); a router with a DSL would be more code to read
/// and more to go wrong.
library;

import 'package:flutter/material.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:besonc_auth/auth_screens.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../screens/home_screen.dart';
import '../state/cart_controller.dart';
import '../state/home_controller.dart';
import 'environment.dart';

/// Everything long-lived, in one object, reachable from any screen.
class AppDependencies {
  AppDependencies({
    required this.api,
    required this.auth,
    required this.environment,
    CartController? cart,
  }) : cart = cart ?? CartController();

  final BesoncApi api;
  final AuthController auth;
  final BesoncEnvironment environment;
  final CartController cart;

  void dispose() {
    auth.dispose();
    cart.dispose();
  }
}

class BesoncScope extends InheritedWidget {
  const BesoncScope({super.key, required this.deps, required super.child});

  final AppDependencies deps;

  static AppDependencies of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<BesoncScope>();
    assert(scope != null, 'BesoncScope is missing above this widget');
    return scope!.deps;
  }

  @override
  bool updateShouldNotify(BesoncScope oldWidget) => oldWidget.deps != deps;
}

/* ------------------------------------------------------------------ */

class BesoncCustomerApp extends StatefulWidget {
  const BesoncCustomerApp({super.key, required this.deps});

  final AppDependencies deps;

  @override
  State<BesoncCustomerApp> createState() => _BesoncCustomerAppState();
}

class _BesoncCustomerAppState extends State<BesoncCustomerApp> {
  @override
  void initState() {
    super.initState();
    // Kick the session restore immediately; the gate shows a splash until
    // it resolves, so this is the app's real startup path.
    widget.deps.auth.restore();
  }

  @override
  Widget build(BuildContext context) {
    return BesoncScope(
      deps: widget.deps,
      child: MaterialApp(
        title: 'Besonc',
        debugShowCheckedModeBanner: false,
        theme: besoncTheme(),
        home: AuthGate(
          auth: widget.deps.auth,
          tagline: 'Food, groceries, parcels — delivered across Accra.',
          child: const CustomerRoot(),
        ),
      ),
    );
  }
}

/// What the customer sees once signed in.
class CustomerRoot extends StatefulWidget {
  const CustomerRoot({super.key});

  @override
  State<CustomerRoot> createState() => _CustomerRootState();
}

class _CustomerRootState extends State<CustomerRoot> {
  HomeController? _home;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Built here rather than in initState because it needs the scope.
    if (_home == null) {
      final deps = BesoncScope.of(context);
      _home = HomeController(api: deps.api);
      _home!.load();
    }
  }

  @override
  void dispose() {
    _home?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final deps = BesoncScope.of(context);
    final home = _home!;

    return AnimatedBuilder(
      animation: home,
      builder: (context, _) {
        // A brand-new account has no name yet; collect it before showing a
        // home screen full of things they cannot check out with anyway.
        final user = deps.auth.user;
        if (user != null && user.needsProfile) {
          return ProfileSetupScreen(
            auth: deps.auth,
            onDone: () => setState(() {}),
          );
        }

        return RefreshIndicator(
          onRefresh: home.load,
          child: HomeScreen(
            state: home.state,
            data: home.data,
            errorMessage: home.errorMessage,
            onRetry: home.load,
            onSearch: () => _notYet(context, 'Search'),
            onChangeAddress: () => _notYet(context, 'Address picker'),
            onOpenService: (key) => _notYet(context, key),
            onOpenStore: (id) => _notYet(context, 'Store $id'),
            onOpenActiveOrder: () => _notYet(context, 'Order tracking'),
          ),
        );
      },
    );
  }

  /// Honest placeholder. Better than a dead tap while these screens land.
  void _notYet(BuildContext context, String what) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$what is coming in the next build')),
    );
  }
}
