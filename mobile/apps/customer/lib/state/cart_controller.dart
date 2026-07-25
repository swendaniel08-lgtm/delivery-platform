/// Cart state for the customer app. PDF §13.
///
/// The client mirrors server rules so the UI can respond instantly — a
/// customer on 3G should not wait for a round trip to learn that "Protein"
/// is required. But the mirror is *advisory only*: prices are recomputed
/// server-side at checkout, and this class never sends an amount.
///
/// The one-vendor rule lives here rather than in a widget, because it has to
/// hold across the whole session regardless of which screen adds an item.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

/// Raised when adding an item from a different vendor (PDF §13).
class DifferentVendorException implements Exception {
  DifferentVendorException(this.currentStoreName, this.newStoreName);
  final String currentStoreName;
  final String newStoreName;

  String get message =>
      'Your cart has items from $currentStoreName. '
      'Start a new cart to order from $newStoreName?';
}

class CartItemDraft {
  CartItemDraft({
    required this.itemId,
    required this.name,
    required this.basePrice,
    required this.storeId,
    required this.storeName,
    this.quantity = 1,
    Set<String>? addonIds,
    Set<String>? variantIds,
    this.addonTotal = const Pesewas(0),
    this.note,
  })  : addonIds = addonIds ?? {},
        variantIds = variantIds ?? {};

  final String itemId;
  final String name;
  final Pesewas basePrice;
  final String storeId;
  final String storeName;
  int quantity;
  final Set<String> addonIds;
  final Set<String> variantIds;
  final Pesewas addonTotal;
  final String? note;

  /// Two lines merge only when the item AND every option matches — the same
  /// dish with different protein is genuinely two lines.
  String get signature {
    final a = (addonIds.toList()..sort()).join(',');
    final v = (variantIds.toList()..sort()).join(',');
    return '$itemId|$a|$v|${note ?? ''}';
  }

  Pesewas get unitPrice => Pesewas(basePrice.value + addonTotal.value);
  Pesewas get lineTotal => Pesewas(unitPrice.value * quantity);

  Map<String, dynamic> toJson() => {
        'itemId': itemId,
        'quantity': quantity,
        if (addonIds.isNotEmpty) 'addonOptionIds': addonIds.toList(),
        if (variantIds.isNotEmpty) 'variantOptionIds': variantIds.toList(),
        if (note != null && note!.isNotEmpty) 'note': note,
      };

  CartItemDraft copyWith({int? quantity}) => CartItemDraft(
        itemId: itemId, name: name, basePrice: basePrice,
        storeId: storeId, storeName: storeName,
        quantity: quantity ?? this.quantity,
        addonIds: addonIds, variantIds: variantIds,
        addonTotal: addonTotal, note: note,
      );
}

/// Maximum per line, matching the server's guard.
const int kMaxLineQuantity = 99;

class CartController extends ChangeNotifier {
  final List<CartItemDraft> _lines = [];

  List<CartItemDraft> get lines => List.unmodifiable(_lines);
  bool get isEmpty => _lines.isEmpty;
  int get itemCount => _lines.fold(0, (sum, l) => sum + l.quantity);

  String? get storeId => _lines.isEmpty ? null : _lines.first.storeId;
  String? get storeName => _lines.isEmpty ? null : _lines.first.storeName;

  /// Client-side subtotal for instant feedback. The server recomputes this
  /// at checkout and its answer wins.
  Pesewas get subtotal =>
      Pesewas(_lines.fold(0, (sum, l) => sum + l.lineTotal.value));

  /// Adds an item, enforcing one vendor per cart.
  ///
  /// Throws [DifferentVendorException] so the UI can offer the
  /// "start a new cart?" choice rather than silently discarding either cart.
  void add(CartItemDraft draft) {
    if (draft.quantity < 1) {
      throw ArgumentError('quantity must be at least 1');
    }
    if (_lines.isNotEmpty && _lines.first.storeId != draft.storeId) {
      throw DifferentVendorException(_lines.first.storeName, draft.storeName);
    }

    final existing = _lines.indexWhere((l) => l.signature == draft.signature);
    if (existing >= 0) {
      final merged = _lines[existing].quantity + draft.quantity;
      _lines[existing] = _lines[existing].copyWith(
        quantity: merged > kMaxLineQuantity ? kMaxLineQuantity : merged,
      );
    } else {
      _lines.add(draft);
    }
    notifyListeners();
  }

  /// Discards the current cart and starts fresh with this item.
  void replaceWith(CartItemDraft draft) {
    _lines
      ..clear()
      ..add(draft);
    notifyListeners();
  }

  void setQuantity(String signature, int quantity) {
    final i = _lines.indexWhere((l) => l.signature == signature);
    if (i < 0) return;
    if (quantity <= 0) {
      _lines.removeAt(i);
    } else {
      _lines[i] = _lines[i].copyWith(
        quantity: quantity > kMaxLineQuantity ? kMaxLineQuantity : quantity,
      );
    }
    notifyListeners();
  }

  void increment(String signature) {
    final line = _lines.firstWhere(
      (l) => l.signature == signature,
      orElse: () => throw StateError('no such line'),
    );
    setQuantity(signature, line.quantity + 1);
  }

  void decrement(String signature) {
    final line = _lines.firstWhere(
      (l) => l.signature == signature,
      orElse: () => throw StateError('no such line'),
    );
    setQuantity(signature, line.quantity - 1);
  }

  void remove(String signature) {
    _lines.removeWhere((l) => l.signature == signature);
    notifyListeners();
  }

  void clear() {
    _lines.clear();
    notifyListeners();
  }

  /// Checkout payload. Note what is absent: no prices, no totals. The client
  /// sends intent; the server decides what it costs.
  Map<String, dynamic> toCheckoutPayload() => {
        'storeId': storeId,
        'lines': _lines.map((l) => l.toJson()).toList(),
      };
}

/* ------------------------------------------------------------------ */
/* Item configuration (the addon sheet)                                */
/* ------------------------------------------------------------------ */

/// Tracks selections while the customer configures one item, and reports
/// whether the "Add to cart" button should be enabled.
class ItemConfiguration extends ChangeNotifier {
  ItemConfiguration({
    required this.itemId,
    required this.name,
    required this.basePrice,
    required this.storeId,
    required this.storeName,
    required this.addonGroups,
  });

  final String itemId;
  final String name;
  final Pesewas basePrice;
  final String storeId;
  final String storeName;
  final List<AddonGroup> addonGroups;

  final Set<String> _selected = {};
  int _quantity = 1;
  String? _note;

  Set<String> get selected => Set.unmodifiable(_selected);
  int get quantity => _quantity;
  String? get note => _note;

  bool isSelected(String optionId) => _selected.contains(optionId);

  /// Toggles an option, respecting the group's maximum.
  ///
  /// When a single-choice group is at its limit, selecting a new option
  /// REPLACES the old one rather than doing nothing — a radio button that
  /// silently ignores taps feels broken.
  void toggle(AddonGroup group, String optionId) {
    if (_selected.contains(optionId)) {
      _selected.remove(optionId);
      notifyListeners();
      return;
    }

    final chosenInGroup =
        group.options.where((o) => _selected.contains(o.id)).toList();

    if (chosenInGroup.length >= group.maxSelections) {
      if (group.maxSelections == 1) {
        _selected.remove(chosenInGroup.first.id);
      } else {
        return; // at the limit for a multi-select: ignore
      }
    }
    _selected.add(optionId);
    notifyListeners();
  }

  void setQuantity(int q) {
    _quantity = q.clamp(1, kMaxLineQuantity);
    notifyListeners();
  }

  void setNote(String? value) {
    _note = (value == null || value.trim().isEmpty) ? null : value.trim();
    notifyListeners();
  }

  Pesewas get addonTotal {
    var total = 0;
    for (final g in addonGroups) {
      for (final o in g.options) {
        if (_selected.contains(o.id)) total += o.price.value;
      }
    }
    return Pesewas(total);
  }

  Pesewas get lineTotal =>
      Pesewas((basePrice.value + addonTotal.value) * _quantity);

  /// First unmet requirement, or null when the item can be added.
  String? get validationError {
    for (final g in addonGroups) {
      final err = g.validate(_selected);
      if (err != null) return err;
    }
    // An option that went out of stock while the sheet was open.
    for (final g in addonGroups) {
      for (final o in g.options) {
        if (_selected.contains(o.id) && !o.available) {
          return '${o.name} is out of stock';
        }
      }
    }
    return null;
  }

  bool get canAdd => validationError == null;

  CartItemDraft toDraft() => CartItemDraft(
        itemId: itemId,
        name: name,
        basePrice: basePrice,
        storeId: storeId,
        storeName: storeName,
        quantity: _quantity,
        addonIds: Set.of(_selected),
        addonTotal: addonTotal,
        note: _note,
      );
}
