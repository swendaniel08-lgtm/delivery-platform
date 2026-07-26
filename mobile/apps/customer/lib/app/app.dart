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
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_ui/besonc_ui.dart';

import '../screens/cart_screen.dart';
import '../screens/checkout_screen.dart';
import '../screens/home_screen.dart';
import '../screens/tracking_screen.dart';
import '../screens/vendor_screen.dart';
import '../state/cart_controller.dart';
import '../state/checkout_controller.dart';
import '../state/home_controller.dart';
import '../state/shopping_flow.dart';
import '../state/tracking_controller.dart';
import '../state/tracking_session.dart';
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
            onOpenStore: (id) => _openStore(context, id),
            onOpenActiveOrder: () {
              final active = home.data?.activeOrder;
              if (active != null) _openTracking(context, deps, active);
            },
          ),
        );
      },
    );
  }

  /* ---------------- navigation ---------------- */

  void _openTracking(
    BuildContext context, AppDependencies deps, ActiveOrder order,
  ) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TrackingPage(deps: deps, order: order),
    ));
  }

  void _openStore(BuildContext context, String storeId) {
    final deps = BesoncScope.of(context);
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => StorePage(deps: deps, storeId: storeId),
    ));
  }

  /// Honest placeholder. Better than a dead tap while these screens land.
  void _notYet(BuildContext context, String what) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$what is coming in the next build')),
    );
  }
}


/* ------------------------------------------------------------------ */
/* Store -> cart -> checkout                                           */
/* ------------------------------------------------------------------ */

class StorePage extends StatefulWidget {
  const StorePage({super.key, required this.deps, required this.storeId});

  final AppDependencies deps;
  final String storeId;

  @override
  State<StorePage> createState() => _StorePageState();
}

class _StorePageState extends State<StorePage> {
  late final StorePageController _store = StorePageController(
    api: widget.deps.api, storeId: widget.storeId,
  )..load();

  @override
  void dispose() {
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _store,
      builder: (context, _) {
        if (_store.state == StoreLoad.loading) {
          return const Scaffold(
            key: Key('store-loading'),
            backgroundColor: BesoncColors.canvas,
            body: Center(child: CircularProgressIndicator()),
          );
        }
        if (_store.state == StoreLoad.failed) {
          return Scaffold(
            backgroundColor: BesoncColors.canvas,
            appBar: AppBar(),
            body: BesoncEmpty(
              key: const Key('store-error'),
              icon: Icons.wifi_off,
              title: 'Cannot load this vendor',
              message: _store.error,
              onRetry: _store.load,
            ),
          );
        }

        return VendorScreen(
          store: _store.store!,
          categories: _store.categories,
          cart: widget.deps.cart,
          onConfigureItem: (item) => _addItem(context, item),
          onViewCart: () => _openCart(context),
        );
      },
    );
  }

  /// Adds one unit, enforcing the one-vendor-per-cart rule with a dialog
  /// rather than a silent replacement.
  Future<void> _addItem(BuildContext context, MenuItem item) async {
    final cart = widget.deps.cart;
    final draft = CartItemDraft(
      itemId: item.id,
      name: item.name,
      basePrice: item.price,
      storeId: _store.store!.id,
      storeName: _store.store!.name,
    );

    try {
      cart.add(draft);
    } on DifferentVendorException catch (e) {
      if (!context.mounted) return;
      final replace = await DifferentVendorDialog.show(
        context, currentStore: e.currentStoreName, newStore: e.newStoreName,
      );
      if (!replace) return;
      cart.replaceWith(draft);
    }
  }

  void _openCart(BuildContext context) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => CartPage(deps: widget.deps, storeIsOpen: _store.store!.isOpen),
    ));
  }
}

class CartPage extends StatelessWidget {
  const CartPage({super.key, required this.deps, this.storeIsOpen = true});

  final AppDependencies deps;
  final bool storeIsOpen;

  @override
  Widget build(BuildContext context) {
    return CartScreen(
      cart: deps.cart,
      storeIsOpen: storeIsOpen,
      onAddMore: () => Navigator.of(context).pop(),
      onBrowse: () => Navigator.of(context).popUntil((r) => r.isFirst),
      onCheckout: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => CheckoutPage(deps: deps),
      )),
    );
  }
}

class CheckoutPage extends StatefulWidget {
  const CheckoutPage({super.key, required this.deps});

  final AppDependencies deps;

  @override
  State<CheckoutPage> createState() => _CheckoutPageState();
}

class _CheckoutPageState extends State<CheckoutPage> {
  late final CheckoutController _checkout =
      CheckoutController(walletBalance: const Pesewas(0));
  late final CheckoutFlow _flow = CheckoutFlow(
    api: widget.deps.api, cart: widget.deps.cart, checkout: _checkout,
  );

  @override
  void initState() {
    super.initState();
    _loadAddressAndQuote();
  }

  @override
  void dispose() {
    _checkout.dispose();
    super.dispose();
  }

  Future<void> _loadAddressAndQuote() async {
    try {
      final res = await widget.deps.api.get('/api/users/me/addresses');
      final list = res['addresses'] as List<dynamic>? ?? [];
      final def = list.cast<Map<String, dynamic>>().firstWhere(
            (a) => a['isDefault'] == true,
            orElse: () => list.isEmpty
                ? <String, dynamic>{}
                : list.first as Map<String, dynamic>,
          );
      if (def.isNotEmpty) {
        _checkout.setAddress(Address.fromJson({
          'id': def['id'],
          'label': def['label'],
          'lat': def['latitude'],
          'lng': def['longitude'],
          'areaName': def['areaName'],
          'landmark': def['landmark'],
        }));
      }
    } catch (_) {
      // The blocker on the button already says "Choose a delivery address".
    }
    // AFTER the address: setAddress clears any existing quote because the
    // delivery fee depends on distance. Quoting first would show a total
    // that is silently wrong for the address actually being delivered to.
    await _flow.refreshQuote();
  }

  /// Choose a different saved address.
  ///
  /// A bottom sheet over the saved list. The full map picker is a later
  /// build, but switching between addresses you already have is the common
  /// case and should not wait for it.
  Future<void> _pickAddress(BuildContext context) async {
    List<dynamic> list;
    try {
      final res = await widget.deps.api.get('/api/users/me/addresses');
      list = res['addresses'] as List<dynamic>? ?? [];
    } catch (_) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not load your addresses')),
      );
      return;
    }
    if (!context.mounted || list.isEmpty) return;

    final chosen = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      builder: (sheet) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final a in list.cast<Map<String, dynamic>>())
              ListTile(
                key: Key('address-${a['id']}'),
                leading: const Icon(Icons.location_on_outlined),
                title: Text(a['label'] as String? ?? 'Address'),
                // The landmark, because that is what identifies a place in
                // Ghana far better than a street name does.
                subtitle: a['landmark'] == null
                    ? null : Text(a['landmark'] as String),
                onTap: () => Navigator.of(sheet).pop(a),
              ),
          ],
        ),
      ),
    );

    if (chosen != null) {
      await _changeAddress(Address.fromJson({
        'id': chosen['id'],
        'label': chosen['label'],
        'lat': chosen['latitude'],
        'lng': chosen['longitude'],
        'areaName': chosen['areaName'],
        'landmark': chosen['landmark'],
      }));
    }
  }

  /// Re-quote whenever the delivery address changes.
  ///
  /// Without this the screen shows "Calculating your total…" forever after
  /// an address change: setAddress correctly invalidates the quote, and
  /// nothing would ask for a new one.
  Future<void> _changeAddress(Address address) async {
    _checkout.setAddress(address);
    await _flow.refreshQuote();
  }

  @override
  Widget build(BuildContext context) {
    return CheckoutScreen(
      controller: _checkout,
      onPlaceOrder: () async {
        final orderId = await _flow.placeOrder();
        if (orderId != null && _checkout.stage == CheckoutStage.awaitingMomo) {
          await _flow.awaitConfirmation(orderId);
        }
      },
      onChangeAddress: () => _pickAddress(context),
      onRetry: () {
        _checkout.backToEditing();
        _flow.refreshQuote();
      },
      onDone: () => Navigator.of(context).popUntil((r) => r.isFirst),
    );
  }
}


/// Live tracking for one order.
class TrackingPage extends StatefulWidget {
  const TrackingPage({super.key, required this.deps, required this.order});

  final AppDependencies deps;
  final ActiveOrder order;

  @override
  State<TrackingPage> createState() => _TrackingPageState();
}

class _TrackingPageState extends State<TrackingPage> {
  late final TrackingController _tracking = TrackingController(
    orderId: widget.order.id,
    initialState: widget.order.state,
  );
  late final TrackingSession _session = TrackingSession(
    api: widget.deps.api, controller: _tracking,
  );

  @override
  void initState() {
    super.initState();
    _begin();
  }

  Future<void> _begin() async {
    final token = await widget.deps.api.tokens.accessToken();
    // A missing token means the session expired; the auth gate will take
    // over on the next request, so there is nothing useful to do here.
    if (token != null) await _session.start(token);
  }

  @override
  void dispose() {
    // Stop polling the moment the screen closes, or a backgrounded app
    // quietly eats a customer's data bundle.
    _session.stop();
    _tracking.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TrackingScreen(
        controller: _tracking,
        humanRef: widget.order.humanRef,
        destination: widget.order.dropoff,
        pickup: widget.order.pickup,
        onClose: () => Navigator.of(context).pop(),
        onCall: () => _notReady(context, 'Calling your rider'),
        onChat: () => _notReady(context, 'Chat'),
        onCancel: () => _notReady(context, 'Cancelling'),
      );

  void _notReady(BuildContext context, String what) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$what is coming in the next build')),
    );
  }
}
