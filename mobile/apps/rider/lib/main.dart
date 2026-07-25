/// Besonc rider app entry point.
library;

import 'package:flutter/material.dart';
import 'package:besonc_api/besonc_api.dart';
import 'package:besonc_api/io_transport.dart';
import 'package:besonc_auth/besonc_auth.dart';
import 'package:path_provider/path_provider.dart';

import 'app/app.dart';
import 'app/environment.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final env = RiderEnvironment.fromDefines();
  final dir = await getApplicationSupportDirectory();
  final tokens = PersistentTokenStore(FileSecureStore('${dir.path}/besonc-rider'));

  late final AuthController auth;
  final api = BesoncApi(
    baseUrl: env.apiBaseUrl,
    transport: IoHttpTransport(userAgent: 'BesoncRider/0.1 (Android)'),
    tokens: tokens,
    onAuthLost: () => auth.onSessionExpired(),
  );
  auth = AuthController(api: api, role: AuthRole.rider);

  runApp(BesoncRiderApp(
    deps: RiderDependencies(api: api, auth: auth, environment: env),
  ));
}
