/// Address selection. PDF §5 — the Ghana address problem.
///
/// Most of Ghana has no reliable street addressing. People navigate by
/// landmarks. So the model here is deliberately inverted from a Western
/// address form:
///
///   * the GPS pin is the ONLY authoritative field
///   * the landmark is the field riders actually read, and is strongly
///     encouraged rather than optional-looking
///   * GhanaPostGPS is offered for those who have it, but never required
///   * reverse geocoding fills the area name as a convenience and is
///     allowed to fail without blocking anything
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_models/besonc_models.dart';

enum AddressEntryMode { currentLocation, searchPlace, ghanaPost, savedAddress }

/// A GhanaPostGPS digital address, e.g. GA-123-4567.
class GhanaPostAddress {
  const GhanaPostAddress(this.value);
  final String value;

  static final _pattern = RegExp(r'^[A-Z]{2}-\d{3,4}-\d{4}$');

  /// Normalises casing and separators before validating: people type
  /// "ga 123 4567" as often as the canonical form.
  static String? normalise(String raw) {
    final cleaned = raw.trim().toUpperCase().replaceAll(RegExp(r'[\s_]+'), '-');
    return _pattern.hasMatch(cleaned) ? cleaned : null;
  }

  static bool isValid(String raw) => normalise(raw) != null;
}

class PlaceSuggestion {
  const PlaceSuggestion({
    required this.placeId,
    required this.mainText,
    required this.secondaryText,
  });
  final String placeId;
  final String mainText;
  final String secondaryText;

  factory PlaceSuggestion.fromJson(Map<String, dynamic> j) => PlaceSuggestion(
        placeId: j['placeId'] as String,
        mainText: j['mainText'] as String? ?? '',
        secondaryText: j['secondaryText'] as String? ?? '',
      );
}

/// Ghana's bounding box. A pin outside it is a map-drag accident, not a
/// deliverable address.
class GhanaBounds {
  static const minLat = 4.5, maxLat = 11.2, minLng = -3.3, maxLng = 1.25;

  static bool contains(LatLng p) =>
      p.lat >= minLat && p.lat <= maxLat && p.lng >= minLng && p.lng <= maxLng;
}

class AddressDraft {
  AddressDraft({
    this.position,
    this.label = 'Home',
    this.areaName,
    this.landmark,
    this.instructions,
    this.ghanaPost,
    this.contactPhone,
  });

  LatLng? position;
  String label;
  String? areaName;
  String? landmark;
  String? instructions;
  String? ghanaPost;
  String? contactPhone;
}

class AddressController extends ChangeNotifier {
  AddressController({List<Address> saved = const []}) : _saved = List.of(saved);

  final List<Address> _saved;
  final AddressDraft _draft = AddressDraft();

  AddressEntryMode _mode = AddressEntryMode.currentLocation;
  List<PlaceSuggestion> _suggestions = const [];
  bool _searching = false;
  bool _geocoding = false;
  String? _error;

  List<Address> get saved => List.unmodifiable(_saved);
  AddressDraft get draft => _draft;
  AddressEntryMode get mode => _mode;
  List<PlaceSuggestion> get suggestions => List.unmodifiable(_suggestions);
  bool get searching => _searching;
  bool get geocoding => _geocoding;
  String? get error => _error;

  LatLng? get position => _draft.position;
  String? get areaName => _draft.areaName;

  void setMode(AddressEntryMode m) {
    _mode = m;
    _suggestions = const [];
    _error = null;
    notifyListeners();
  }

  /* ---------------- pin ---------------- */

  /// Moves the map pin. Rejects positions outside Ghana rather than letting
  /// a stray drag produce an undeliverable order.
  bool setPosition(LatLng p) {
    if (!GhanaBounds.contains(p)) {
      _error = 'That location is outside Ghana. Move the pin back.';
      notifyListeners();
      return false;
    }
    _draft.position = p;
    // The old area name belongs to the old pin.
    _draft.areaName = null;
    _error = null;
    notifyListeners();
    return true;
  }

  /// Result of reverse geocoding. Convenience only — never blocking.
  void setAreaName(String? name) {
    _draft.areaName = name;
    notifyListeners();
  }

  void setGeocoding(bool value) {
    _geocoding = value;
    notifyListeners();
  }

  /* ---------------- text fields ---------------- */

  void setLabel(String value) {
    final v = value.trim();
    _draft.label = v.isEmpty ? 'Home' : v;
    notifyListeners();
  }

  void setLandmark(String? value) {
    _draft.landmark = _clean(value);
    notifyListeners();
  }

  void setInstructions(String? value) {
    _draft.instructions = _clean(value);
    notifyListeners();
  }

  void setContactPhone(String? value) {
    _draft.contactPhone = _clean(value);
    notifyListeners();
  }

  /// Accepts a GhanaPostGPS code. Returns false when malformed so the field
  /// can show an inline error instead of failing on submit.
  bool setGhanaPost(String? raw) {
    if (raw == null || raw.trim().isEmpty) {
      _draft.ghanaPost = null;
      _error = null;
      notifyListeners();
      return true;
    }
    final normalised = GhanaPostAddress.normalise(raw);
    if (normalised == null) {
      _error = 'A GhanaPostGPS address looks like GA-123-4567';
      notifyListeners();
      return false;
    }
    _draft.ghanaPost = normalised;
    _error = null;
    notifyListeners();
    return true;
  }

  static String? _clean(String? v) =>
      (v == null || v.trim().isEmpty) ? null : v.trim();

  /* ---------------- place search ---------------- */

  void setSearching(bool value) {
    _searching = value;
    notifyListeners();
  }

  /// Google bills Autocomplete per session, and short prefixes return noise.
  /// Below three characters we do not call at all.
  bool shouldQuery(String input) => input.trim().length >= 3;

  void setSuggestions(List<PlaceSuggestion> value) {
    _suggestions = value;
    _searching = false;
    notifyListeners();
  }

  void clearSuggestions() {
    _suggestions = const [];
    notifyListeners();
  }

  /* ---------------- validation ---------------- */

  /// Why the address cannot be saved yet, or null when it can.
  ///
  /// Note what is NOT required: an area name, a GhanaPost code, or
  /// instructions. Requiring any of them would block real customers whose
  /// area simply has no name in Google's data.
  String? get blocker {
    if (_draft.position == null) return 'Drop a pin on your location';
    if (!GhanaBounds.contains(_draft.position!)) {
      return 'That location is outside Ghana';
    }
    if (_draft.landmark == null || _draft.landmark!.length < 3) {
      return 'Add a landmark so your rider can find you';
    }
    return null;
  }

  bool get canSave => blocker == null;

  /// Warnings that do not block saving but materially improve delivery.
  List<String> get suggestionsForUser {
    final tips = <String>[];
    if (_draft.instructions == null) {
      tips.add('Delivery instructions help riders find you faster');
    }
    if (_draft.contactPhone == null) {
      tips.add('Add a phone number for this address if it is not yours');
    }
    return tips;
  }

  Map<String, dynamic> toPayload() => {
        'label': _draft.label,
        'lat': _draft.position!.lat,
        'lng': _draft.position!.lng,
        'landmark': _draft.landmark,
        if (_draft.areaName != null) 'areaName': _draft.areaName,
        if (_draft.instructions != null) 'instructions': _draft.instructions,
        if (_draft.ghanaPost != null) 'ghanapostAddress': _draft.ghanaPost,
        if (_draft.contactPhone != null) 'contactPhone': _draft.contactPhone,
      };

  /// Loads an existing address for editing.
  void loadFrom(Address a) {
    _draft
      ..position = a.position
      ..label = a.label
      ..areaName = a.areaName
      ..landmark = a.landmark
      ..instructions = a.instructions
      ..ghanaPost = a.ghanaPostAddress;
    _error = null;
    notifyListeners();
  }
}
