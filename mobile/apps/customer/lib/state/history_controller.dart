/// Order history.
///
/// The screen a customer opens when they want a receipt, want to reorder, or
/// — most often — want to check whether they were charged twice. That last
/// case is why this is cursor-paged rather than offset-paged: with OFFSET, an
/// order placed while scrolling shifts the whole newest-first list and page 2
/// re-serves the tail of page 1. Seeing the same order twice on the screen you
/// opened to check for a double charge is the worst possible bug here.
///
/// Two other rules:
///
///   • A load failure is NEVER an empty list. "You have no orders" and "we
///     could not reach the server" are different sentences, and only one of
///     them makes someone phone support asking where their orders went.
///   • The first page and subsequent pages fail differently. Failing page 3
///     must not wipe pages 1 and 2 off the screen.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

/// One row of history, as bff-customer sends it.
@immutable
class HistoryOrder {
  const HistoryOrder({
    required this.id,
    required this.humanRef,
    required this.state,
    required this.service,
    required this.totalDisplay,
    required this.placedAt,
    this.storeName,
    this.isCod = false,
    this.itemCount = 0,
  });

  final String id;
  final String humanRef;
  final OrderState state;
  final String service;

  /// Formatted by the SERVER. The app never formats money — three apps and a
  /// dashboard each doing their own cedi arithmetic is three chances to
  /// disagree about what someone paid.
  final String totalDisplay;

  final DateTime placedAt;
  final String? storeName;
  final bool isCod;
  final int itemCount;

  bool get isActive => !state.isTerminal;

  factory HistoryOrder.fromJson(Map<String, dynamic> j) => HistoryOrder(
        id: j['id'] as String,
        humanRef: j['humanRef'] as String? ?? '',
        state: OrderState.fromWire(j['state'] as String? ?? 'placed'),
        service: j['service'] as String? ?? 'food',
        totalDisplay: j['totalDisplay'] as String? ?? '—',
        // A row with an unparseable date must not take down the whole list;
        // the epoch sorts it last, which is where a broken row belongs.
        placedAt: DateTime.tryParse(j['placedAt'] as String? ?? '')?.toLocal() ??
            DateTime.fromMillisecondsSinceEpoch(0),
        storeName: j['storeName'] as String?,
        isCod: j['isCod'] as bool? ?? false,
        itemCount: (j['itemCount'] as num?)?.toInt() ?? 0,
      );
}

/// What the controller needs from the network.
abstract class HistorySource {
  /// `cursor` null means the first page.
  Future<({List<HistoryOrder> orders, String? nextCursor})> fetch({
    String? cursor,
  });
}

class HistoryController extends ChangeNotifier {
  HistoryController({required HistorySource source}) : _source = source;

  final HistorySource _source;

  final List<HistoryOrder> _orders = [];
  String? _cursor;
  bool _loading = false;
  bool _loadingMore = false;
  bool _loadedOnce = false;
  String? _error;
  String? _pageError;

  List<HistoryOrder> get orders => List.unmodifiable(_orders);

  /// First-page load. Drives the full-screen spinner.
  bool get loading => _loading;

  /// Appending a later page. Drives the footer spinner only.
  bool get loadingMore => _loadingMore;

  /// Fatal for the screen — nothing could be shown at all.
  String? get error => _error;

  /// A later page failed. The rows already on screen are still valid.
  String? get pageError => _pageError;

  bool get hasMore => _cursor != null;

  /// True only once we know the customer genuinely has no orders. Distinct
  /// from "we have not loaded yet" and from "loading failed", because those
  /// three states must not render the same way.
  bool get isEmpty => _loadedOnce && _orders.isEmpty && _error == null;

  Future<void> refresh() async {
    _loading = true;
    _error = null;
    _pageError = null;
    notifyListeners();

    try {
      final page = await _source.fetch();
      _orders
        ..clear()
        ..addAll(page.orders);
      _cursor = page.nextCursor;
      _loadedOnce = true;
      _error = null;
    } catch (_) {
      // Do NOT clear what is already on screen. A pull-to-refresh that fails
      // should leave the previous list visible with a message, not blank the
      // page the customer was reading.
      _error = _orders.isEmpty
          ? 'Could not load your orders'
          : 'Could not refresh — showing what we last loaded';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// Append the next page.
  Future<void> loadMore() async {
    // Guarded against the double-fire a scroll listener produces near the
    // bottom of a list; without it the same cursor is fetched twice and the
    // page appears duplicated.
    if (_loadingMore || _cursor == null) return;

    _loadingMore = true;
    _pageError = null;
    notifyListeners();

    try {
      final page = await _source.fetch(cursor: _cursor);
      // Defensive de-duplication. The server's keyset cursor should make this
      // impossible, but a duplicate row on THIS screen reads as a double
      // charge, so it is worth the set lookup.
      final seen = _orders.map((o) => o.id).toSet();
      _orders.addAll(page.orders.where((o) => !seen.contains(o.id)));
      _cursor = page.nextCursor;
    } catch (_) {
      _pageError = 'Could not load more';
    } finally {
      _loadingMore = false;
      notifyListeners();
    }
  }
}
