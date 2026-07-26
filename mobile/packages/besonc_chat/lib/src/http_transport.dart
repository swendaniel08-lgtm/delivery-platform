/// HTTP transport for order chat.
///
/// Kept in its own file so the chat package's logic and widgets stay free of
/// networking, and so both apps can share one implementation while pointing
/// at different BFF routes:
///
///   customer → /api/customer/orders/:id/chat
///   rider    → /api/rider/jobs/:orderId/chat
///
/// The only interesting decision here is error TRANSLATION. A 403 from the
/// BFF means the 30-minute post-delivery window has shut — a normal, expected
/// end state that the UI renders as an explanation. Everything else is a
/// failure the user can retry. Collapsing the two would either show a scary
/// error for an ordinary closure, or offer a Retry button that can never
/// succeed.
library;

import 'package:besonc_api/besonc_api.dart';

import '../besonc_chat.dart';

class HttpChatTransport implements ChatTransport {
  HttpChatTransport({
    required BesoncApi api,
    required String basePath,
  })  : _api = api,
        _basePath = basePath;

  final BesoncApi _api;

  /// `/api/customer/orders` or `/api/rider/jobs` — the segment before the id.
  final String _basePath;

  String _path(String orderId) => '$_basePath/$orderId/chat';

  @override
  Future<List<ChatMessage>> history(String orderId) async {
    try {
      final json = await _api.get(_path(orderId));
      final raw = json['messages'];
      if (raw is! List) return const [];
      return raw
          .whereType<Map<String, dynamic>>()
          .map(ChatMessage.fromJson)
          .toList(growable: false);
    } on ApiException catch (e) {
      if (e.status == 403) throw const ChatClosedException();
      rethrow;
    }
  }

  @override
  Future<ChatMessage> send(String orderId, String body) async {
    try {
      final json = await _api.post(_path(orderId), body: {'body': body});
      return ChatMessage.fromJson(json);
    } on ApiException catch (e) {
      if (e.status == 403) throw const ChatClosedException();
      rethrow;
    }
  }
}
