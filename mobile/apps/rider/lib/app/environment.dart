/// Build-time configuration.
///
/// Everything that differs between a developer's laptop, staging and
/// production lives here and comes from `--dart-define`, so there is exactly
/// one place to look and no secrets compiled into the binary.
library;

class RiderEnvironment {
  const RiderEnvironment({
    required this.apiBaseUrl,
    required this.wsBaseUrl,
    required this.name,
  });

  final String apiBaseUrl;
  final String wsBaseUrl;
  final String name;

  bool get isProduction => name == 'production';

  /// 10.0.2.2 is how the Android emulator reaches the host machine's
  /// localhost. A plain `localhost` here is the single most common reason a
  /// new developer sees "No connection" on their first run.
  static const _devApi = 'http://10.0.2.2:3000';
  static const _devWs = 'ws://10.0.2.2:3006';

  factory RiderEnvironment.fromDefines() {
    const name = String.fromEnvironment('BESONC_ENV', defaultValue: 'development');
    const api = String.fromEnvironment('BESONC_API_URL', defaultValue: _devApi);
    const ws = String.fromEnvironment('BESONC_WS_URL', defaultValue: _devWs);
    return const RiderEnvironment(apiBaseUrl: api, wsBaseUrl: ws, name: name);
  }
}
