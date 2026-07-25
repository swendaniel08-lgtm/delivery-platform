/// Drives the customer home screen against the customer BFF.
///
/// One call (`GET /api/customer/home`) renders the whole screen. The
/// controller's job is to turn that into exactly three observable states —
/// loading, ready, failed — and to make a refresh never flash a spinner over
/// content the user is already reading.
library;

import 'package:flutter/foundation.dart';
import 'package:besonc_api/besonc_api.dart';

import '../screens/home_screen.dart';

class HomeController extends ChangeNotifier {
  HomeController({required BesoncApi api}) : _api = api;

  final BesoncApi _api;

  LoadState _state = LoadState.loading;
  HomeData? _data;
  String? _errorMessage;
  bool _refreshing = false;

  LoadState get state => _state;
  HomeData? get data => _data;
  String? get errorMessage => _errorMessage;

  /// True during a pull-to-refresh, when content is already on screen.
  bool get refreshing => _refreshing;

  Future<void> load() async {
    // Only show the skeleton when there is nothing to show yet. Replacing a
    // rendered home with a skeleton on every refresh feels broken.
    if (_data == null) {
      _state = LoadState.loading;
    } else {
      _refreshing = true;
    }
    notifyListeners();

    try {
      final json = await _api.get('/api/customer/home');
      _data = HomeData.fromJson(json);
      _state = LoadState.ready;
      _errorMessage = null;
    } on ApiException catch (e) {
      _fail(e.message);
    } on NetworkException catch (e) {
      _fail(e.message);
    } finally {
      _refreshing = false;
      notifyListeners();
    }
  }

  void _fail(String message) {
    _errorMessage = message;
    // A failed refresh must not destroy the screen the user is looking at —
    // keep the stale data and surface the error separately.
    if (_data == null) _state = LoadState.failed;
  }
}
