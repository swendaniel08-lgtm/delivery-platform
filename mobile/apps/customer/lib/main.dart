/// Besonc customer app entry point.
///
/// Composition root: this is the only file that knows about dart:io, the
/// real network, or the filesystem. Everything below it takes its
/// dependencies as arguments, which is what makes the app testable.
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

  final env = BesoncEnvironment.fromDefines();
  final dir = await getApplicationSupportDirectory();

  final tokens = PersistentTokenStore(FileSecureStore('${dir.path}/besonc'));

  // `late` because the API needs an onAuthLost callback that refers to the
  // auth controller, which in turn needs the API. Tying the knot here keeps
  // both of them free of a service locator.
  late final AuthController auth;

  final api = BesoncApi(
    baseUrl: env.apiBaseUrl,
    transport: IoHttpTransport(),
    tokens: tokens,
    onAuthLost: () => auth.onSessionExpired(),
  );

  auth = AuthController(api: api, role: AuthRole.customer);

  runApp(BesoncCustomerApp(
    deps: AppDependencies(api: api, auth: auth, environment: env),
  ));
}
