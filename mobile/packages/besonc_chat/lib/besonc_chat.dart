/// Order chat, shared by the customer and rider apps.
///
/// In Ghana this is not a nice-to-have. Addresses are landmarks — "behind the
/// MTN mast, blue gate" — so the last 200 metres of most deliveries are
/// negotiated in conversation. A rider who cannot ask "which turn after the
/// junction?" makes a phone call, and a phone call costs both sides money and
/// exposes both phone numbers.
///
/// Three rules shape everything here:
///
///   1. **A message that has not been accepted by the server is not sent.**
///      It renders as pending, and if it fails it says so and offers a retry.
///      Optimistically showing a delivered-looking bubble for a message the
///      rider never received is the single worst thing this screen could do.
///   2. **The 30-minute window after delivery closes the chat** (PDF §9). The
///      composer disappears and says why, rather than accepting text that the
///      server will reject.
///   3. **Sending must survive a bad network**, because that is the normal
///      condition. Failures are recoverable in place, never silent.
library;

import 'dart:async';

import 'package:flutter/material.dart';

export 'src/http_transport.dart';

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/// Who sent a message. Mirrors `chat_party` in the messaging schema.
enum ChatParty { customer, rider, vendor }

/// Where a message is in its journey to the server.
enum ChatDelivery {
  /// Written locally, not yet acknowledged. Never shown as delivered.
  pending,

  /// The server has it. This is the only state that means "sent".
  sent,

  /// The send failed. Recoverable — the user can retry in place.
  failed,
}

@immutable
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.from,
    required this.sentAt,
    this.body,
    this.imageUrl,
    this.delivery = ChatDelivery.sent,
  });

  final String id;
  final ChatParty from;
  final DateTime sentAt;
  final String? body;
  final String? imageUrl;
  final ChatDelivery delivery;

  bool get isPending => delivery == ChatDelivery.pending;
  bool get isFailed => delivery == ChatDelivery.failed;

  ChatMessage copyWith({String? id, ChatDelivery? delivery}) => ChatMessage(
        id: id ?? this.id,
        from: from,
        sentAt: sentAt,
        body: body,
        imageUrl: imageUrl,
        delivery: delivery ?? this.delivery,
      );

  static ChatParty partyFrom(String s) => switch (s) {
        'rider' => ChatParty.rider,
        'vendor' => ChatParty.vendor,
        _ => ChatParty.customer,
      };

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id'].toString(),
        from: partyFrom(j['from'] as String? ?? 'customer'),
        // A server timestamp we cannot parse must not crash the transcript.
        // Falling back to "now" keeps ordering sane and the screen usable.
        sentAt: DateTime.tryParse(j['sentAt'] as String? ?? '')?.toLocal() ??
            DateTime.now(),
        body: j['body'] as String?,
        imageUrl: j['imageUrl'] as String?,
      );
}

/// What the transport must provide. Keeps this package free of HTTP.
abstract class ChatTransport {
  Future<List<ChatMessage>> history(String orderId);

  /// Returns the server's version of the message.
  Future<ChatMessage> send(String orderId, String body);
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

/// Chat state for one order.
class ChatController extends ChangeNotifier {
  ChatController({
    required this.orderId,
    required this.me,
    required ChatTransport transport,
    this.pollInterval = const Duration(seconds: 10),
    DateTime Function()? clock,
  })  : _transport = transport,
        _now = clock ?? DateTime.now;

  final String orderId;

  /// Which side of the conversation this app is.
  final ChatParty me;

  final ChatTransport _transport;
  final Duration pollInterval;
  final DateTime Function() _now;

  final List<ChatMessage> _messages = [];
  bool _loading = true;
  bool _closed = false;
  String? _error;
  Timer? _poll;
  int _localSeq = 0;

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get loading => _loading;
  String? get error => _error;

  /// True once the 30-minute post-delivery window has elapsed.
  bool get isClosed => _closed;

  /// Whether the composer should be shown at all.
  bool get canSend => !_closed;

  /// Messages that failed to send and can be retried.
  List<ChatMessage> get failed =>
      _messages.where((m) => m.isFailed).toList(growable: false);

  Future<void> load() async {
    try {
      final loaded = await _transport.history(orderId);
      // Keep local pending/failed messages: a refresh must not silently
      // discard something the user typed and is still waiting on.
      final local = _messages.where((m) => m.isPending || m.isFailed).toList();
      _messages
        ..clear()
        ..addAll(loaded)
        ..addAll(local);
      _sort();
      _error = null;
      _closed = false;
    } on ChatClosedException {
      _closed = true;
      _error = null;
    } catch (e) {
      // Degraded, not broken: whatever was already on screen stays there.
      _error = 'Could not load messages';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// Poll for the other side's replies.
  ///
  /// Polling rather than a socket: the tracking socket already exists for
  /// positions, and a second long-lived connection on a Ghanaian mobile
  /// network is a second thing to drop and reconnect. Ten seconds is well
  /// inside human conversational latency.
  void startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(pollInterval, (_) => _refreshQuietly());
  }

  void stopPolling() {
    _poll?.cancel();
    _poll = null;
  }

  Future<void> _refreshQuietly() async {
    if (_closed) return;
    try {
      final loaded = await _transport.history(orderId);
      final local = _messages.where((m) => m.isPending || m.isFailed).toList();
      _messages
        ..clear()
        ..addAll(loaded)
        ..addAll(local);
      _sort();
      notifyListeners();
    } on ChatClosedException {
      _closed = true;
      stopPolling();
      notifyListeners();
    } catch (_) {
      // A failed background poll is not worth an error banner. The last
      // transcript stays on screen and the next tick tries again.
    }
  }

  /// Send a message.
  ///
  /// The bubble appears immediately as PENDING so the app feels responsive,
  /// but it is visibly not-yet-sent until the server confirms. On failure it
  /// becomes retryable rather than vanishing — a message that disappears is
  /// one the user assumes was delivered.
  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || _closed) return;

    _localSeq += 1;
    final localId = 'local-$_localSeq';
    final optimistic = ChatMessage(
      id: localId,
      from: me,
      sentAt: _now(),
      body: trimmed,
      delivery: ChatDelivery.pending,
    );
    _messages.add(optimistic);
    notifyListeners();

    try {
      final saved = await _transport.send(orderId, trimmed);
      final i = _messages.indexWhere((m) => m.id == localId);
      if (i >= 0) {
        _messages[i] = saved.copyWith(delivery: ChatDelivery.sent);
        _sort();
      }
      _error = null;
    } on ChatClosedException {
      _closed = true;
      _messages.removeWhere((m) => m.id == localId);
      _error = 'This conversation has closed';
    } catch (_) {
      final i = _messages.indexWhere((m) => m.id == localId);
      if (i >= 0) {
        _messages[i] = _messages[i].copyWith(delivery: ChatDelivery.failed);
      }
    }
    notifyListeners();
  }

  /// Retry one failed message.
  Future<void> retry(String id) async {
    final i = _messages.indexWhere((m) => m.id == id);
    if (i < 0) return;
    final msg = _messages[i];
    if (!msg.isFailed || msg.body == null) return;

    _messages[i] = msg.copyWith(delivery: ChatDelivery.pending);
    notifyListeners();

    try {
      final saved = await _transport.send(orderId, msg.body!);
      final j = _messages.indexWhere((m) => m.id == id);
      if (j >= 0) {
        _messages[j] = saved.copyWith(delivery: ChatDelivery.sent);
        _sort();
      }
    } catch (_) {
      final j = _messages.indexWhere((m) => m.id == id);
      if (j >= 0) _messages[j] = _messages[j].copyWith(delivery: ChatDelivery.failed);
    }
    notifyListeners();
  }

  /// The order reached a terminal state; the grace period is running.
  void onDelivered() {
    // The SERVER decides when the window shuts. This only stops polling once
    // it has told us, so the client clock is never the authority.
  }

  void _sort() => _messages.sort((a, b) => a.sentAt.compareTo(b.sentAt));

  @override
  void dispose() {
    stopPolling();
    super.dispose();
  }
}

/// The server refused because the 30-minute window has closed.
class ChatClosedException implements Exception {
  const ChatClosedException([this.message = 'This conversation has closed']);
  final String message;
  @override
  String toString() => message;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

/// The conversation screen body.
class ChatView extends StatefulWidget {
  const ChatView({
    super.key,
    required this.controller,
    this.counterpartyName,
    this.emptyHint,
  });

  final ChatController controller;
  final String? counterpartyName;

  /// Shown on an empty thread. Worth tailoring: the customer and the rider
  /// need different prompts.
  final String? emptyHint;

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChange);
  }

  void _onChange() {
    // Keep the newest message visible as replies arrive.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChange);
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    _input.clear();
    await widget.controller.send(text);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;

    return AnimatedBuilder(
      animation: c,
      builder: (context, _) {
        return Column(
          children: [
            if (c.error != null)
              Container(
                key: const Key('chat-error'),
                width: double.infinity,
                color: const Color(0xFFFDECEC),
                padding: const EdgeInsets.all(10),
                child: Text(
                  c.error!,
                  style: const TextStyle(fontSize: 13, color: Color(0xFF9B2C2C)),
                ),
              ),

            Expanded(
              child: c.loading
                  ? const Center(
                      key: Key('chat-loading'),
                      child: CircularProgressIndicator(),
                    )
                  : c.messages.isEmpty
                      ? _Empty(
                          hint: widget.emptyHint ??
                              'Send a message about this delivery.',
                        )
                      : ListView.builder(
                          key: const Key('chat-list'),
                          controller: _scroll,
                          padding: const EdgeInsets.all(12),
                          itemCount: c.messages.length,
                          itemBuilder: (context, i) {
                            final m = c.messages[i];
                            return _Bubble(
                              message: m,
                              isMine: m.from == c.me,
                              onRetry: m.isFailed ? () => c.retry(m.id) : null,
                            );
                          },
                        ),
            ),

            if (c.isClosed)
              const _ClosedNotice()
            else
              _Composer(controller: _input, onSend: _send),
          ],
        );
      },
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.hint});
  final String hint;

  @override
  Widget build(BuildContext context) => Center(
        key: const Key('chat-empty'),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Text(
            hint,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 14, color: Color(0xFF6B7280)),
          ),
        ),
      );
}

class _ClosedNotice extends StatelessWidget {
  const _ClosedNotice();

  @override
  Widget build(BuildContext context) => Container(
        key: const Key('chat-closed'),
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        color: const Color(0xFFF3F4F6),
        child: const Text(
          // Says WHY. A composer that silently vanishes reads as a bug.
          'This conversation closed 30 minutes after delivery. '
          'Contact support if you still need help with this order.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, color: Color(0xFF6B7280)),
        ),
      );
}

class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.message,
    required this.isMine,
    this.onRetry,
  });

  final ChatMessage message;
  final bool isMine;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final failed = message.isFailed;

    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        // Never full width: a bubble that spans the screen loses the
        // left/right cue that says who is talking.
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.75,
        ),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: failed
              ? const Color(0xFFFDECEC)
              : isMine
                  ? const Color(0xFF1B8A5A)
                  : const Color(0xFFEDEFF2),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message.body ?? '',
              style: TextStyle(
                fontSize: 14,
                color: failed
                    ? const Color(0xFF9B2C2C)
                    : isMine
                        ? Colors.white
                        : const Color(0xFF23282F),
              ),
            ),
            const SizedBox(height: 3),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _time(message.sentAt),
                  style: TextStyle(
                    fontSize: 10,
                    color: failed
                        ? const Color(0xFF9B2C2C)
                        : isMine
                            ? Colors.white70
                            : const Color(0xFF8A8F98),
                  ),
                ),
                if (message.isPending) ...[
                  const SizedBox(width: 5),
                  // "Sending" — never a delivered tick until the server says so.
                  Text(
                    'sending…',
                    key: const Key('chat-pending'),
                    style: TextStyle(
                      fontSize: 10,
                      color: isMine ? Colors.white70 : const Color(0xFF8A8F98),
                    ),
                  ),
                ],
                if (failed && onRetry != null) ...[
                  const SizedBox(width: 8),
                  GestureDetector(
                    key: Key('chat-retry-${message.id}'),
                    onTap: onRetry,
                    child: const Text(
                      'Not sent · Retry',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF9B2C2C),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _time(DateTime t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.onSend});

  final TextEditingController controller;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.all(8),
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: Color(0xFFE3E7EB))),
        ),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('chat-input'),
                controller: controller,
                // The server caps at 1000; stopping here means the user never
                // types a paragraph only to have it rejected.
                maxLength: 1000,
                maxLines: 4,
                minLines: 1,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                decoration: const InputDecoration(
                  hintText: 'Message',
                  counterText: '',
                  isDense: true,
                  border: OutlineInputBorder(),
                  contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
              ),
            ),
            const SizedBox(width: 8),
            IconButton(
              key: const Key('chat-send'),
              onPressed: onSend,
              icon: const Icon(Icons.send, size: 20),
              color: const Color(0xFF1B8A5A),
            ),
          ],
        ),
      ),
    );
  }
}
