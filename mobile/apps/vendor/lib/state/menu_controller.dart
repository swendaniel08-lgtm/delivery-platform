/// Menu state for the vendor app.
///
/// The availability toggle is OPTIMISTIC: it flips immediately and reverts
/// if the server disagrees. A vendor standing at a counter with a queue of
/// customers should not wait on a round trip to mark the tilapia sold out,
/// and on Ghanaian mobile data that round trip can be seconds.
///
/// Reverting is the important half. A toggle that looks like it worked but
/// did not means the kitchen keeps receiving orders it cannot cook.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_models/besonc_models.dart';

enum MenuLoad { loading, ready, failed }

class MenuItemView {
  const MenuItemView({
    required this.id,
    required this.name,
    required this.price,
    required this.isAvailable,
    this.description,
  });

  final String id;
  final String name;
  final Pesewas price;
  final bool isAvailable;
  final String? description;

  MenuItemView copyWith({bool? isAvailable}) => MenuItemView(
        id: id,
        name: name,
        price: price,
        isAvailable: isAvailable ?? this.isAvailable,
        description: description,
      );

  factory MenuItemView.fromJson(Map<String, dynamic> j) => MenuItemView(
        id: j['id'] as String,
        name: j['name'] as String,
        price: Pesewas.parse(j['basePricePesewas'] as String? ?? '0'),
        isAvailable: j['isAvailable'] as bool? ?? true,
        description: j['description'] as String?,
      );
}

/// Named `Vendor…` deliberately: Flutter's material library exports its own
/// `MenuController`, and an ambiguous import is a confusing failure.
class VendorMenuController extends ChangeNotifier {
  VendorMenuController({required BesoncApi api}) : _api = api;

  final BesoncApi _api;

  MenuLoad _state = MenuLoad.loading;
  List<MenuItemView> _items = const [];
  String? _error;

  /// Items with a toggle in flight. Their switch is replaced by a spinner
  /// so a second tap cannot race the first.
  final Set<String> _pending = {};

  MenuLoad get state => _state;
  List<MenuItemView> get items => List.unmodifiable(_items);
  String? get error => _error;
  bool isPending(String id) => _pending.contains(id);

  int get soldOutCount => _items.where((i) => !i.isAvailable).length;

  Future<void> load() async {
    if (_items.isEmpty) _state = MenuLoad.loading;
    notifyListeners();

    try {
      final json = await _api.get('/api/vendor/menu');
      _items = (json['items'] as List<dynamic>? ?? [])
          .map((i) => MenuItemView.fromJson(i as Map<String, dynamic>))
          .toList();
      _state = MenuLoad.ready;
      _error = null;
    } on ApiException catch (e) {
      _fail(e.message);
    } on NetworkException catch (e) {
      _fail(e.message);
    }
    notifyListeners();
  }

  void _fail(String message) {
    _error = message;
    // Keep whatever is already on screen; a failed refresh should not blank
    // a menu the vendor is working through.
    if (_items.isEmpty) _state = MenuLoad.failed;
  }

  /// Flip availability. Optimistic, with a revert on failure.
  Future<bool> setAvailability(String itemId, bool available) async {
    if (_pending.contains(itemId)) return false;

    final index = _items.indexWhere((i) => i.id == itemId);
    if (index < 0) return false;
    final previous = _items[index];

    _pending.add(itemId);
    _items = [..._items]..[index] = previous.copyWith(isAvailable: available);
    _error = null;
    notifyListeners();

    try {
      await _api.patch(
        '/api/vendor/menu/$itemId/availability',
        body: {'isAvailable': available},
      );
      return true;
    } catch (e) {
      // Put it back. A switch that stayed flipped while the server still
      // sells the dish is worse than one that visibly failed.
      final at = _items.indexWhere((i) => i.id == itemId);
      if (at >= 0) _items = [..._items]..[at] = previous;
      _error = e is ApiException
          ? e.message
          : e is NetworkException
              ? e.message
              : 'Could not update ${previous.name}';
      return false;
    } finally {
      _pending.remove(itemId);
      notifyListeners();
    }
  }

  /// Add a dish. Reloads so the new item arrives with its server id.
  Future<bool> addItem({required String name, required int pricePesewas}) async {
    try {
      await _api.post('/api/vendor/menu', body: {
        'name': name,
        'basePricePesewas': pricePesewas.toString(),
      });
      await load();
      return true;
    } on ApiException catch (e) {
      _error = e.message;
      notifyListeners();
      return false;
    } on NetworkException catch (e) {
      _error = e.message;
      notifyListeners();
      return false;
    }
  }
}
