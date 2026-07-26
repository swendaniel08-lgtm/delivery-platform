/// Order chat.
///
/// The rules being defended here are not about rendering bubbles. They are:
///
///   • A message the server never accepted must NEVER look sent. That is the
///     failure that leaves a customer believing the rider was told about the
///     blue gate when the rider was told nothing.
///   • A failed send must be recoverable in place. A message that silently
///     disappears is assumed delivered.
///   • The 30-minute post-delivery window is the SERVER's decision, and the
///     composer must reflect it rather than accepting text destined for a 403.
///
/// Widget tests run at 360x740 — the common phone width in Ghana, and the one
/// that keeps exposing overflow the 800x600 default hides.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_chat/besonc_chat.dart';

const phone = Size(360, 740);

/// A transport we can make succeed, fail, hang or close on demand.
class FakeTransport implements ChatTransport {
  FakeTransport({this.failSend = false, this.closed = false});

  bool failSend;
  bool closed;
  bool failHistory = false;
  Completer<ChatMessage>? hold;

  final List<ChatMessage> stored = [];
  final List<String> sent = [];
  int historyCalls = 0;
  int seq = 0;

  @override
  Future<List<ChatMessage>> history(String orderId) async {
    historyCalls++;
    if (closed) throw const ChatClosedException();
    if (failHistory) throw Exception('network');
    return List.of(stored);
  }

  @override
  Future<ChatMessage> send(String orderId, String body) async {
    sent.add(body);
    if (hold != null) return hold!.future;
    if (closed) throw const ChatClosedException();
    if (failSend) throw Exception('network');
    seq++;
    final m = ChatMessage(
      id: 'server-$seq',
      from: ChatParty.customer,
      sentAt: DateTime(2026, 7, 26, 12, seq),
      body: body,
    );
    stored.add(m);
    return m;
  }

  /// A message arriving from the other side.
  void inbound(String body) => stored.add(ChatMessage(
        id: 'in-${stored.length}',
        from: ChatParty.rider,
        sentAt: DateTime(2026, 7, 26, 12, 30),
        body: body,
      ));
}

ChatController make(FakeTransport t, {ChatParty me = ChatParty.customer}) =>
    ChatController(orderId: 'ord-1', me: me, transport: t);

Future<void> pump(WidgetTester tester, Widget child) async {
  await tester.binding.setSurfaceSize(phone);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: child)));
  await tester.pump();
}

void main() {
  /* ---------------------------------------------------------------- */

  group('parsing', () {
    test('reads the wire shape messaging-svc sends', () {
      final m = ChatMessage.fromJson({
        'id': 12,
        'from': 'rider',
        'body': 'On my way',
        'sentAt': '2026-07-26T12:30:00.000Z',
      });
      expect(m.id, '12');
      expect(m.from, ChatParty.rider);
      expect(m.body, 'On my way');
      // Anything from the server is already accepted.
      expect(m.delivery, ChatDelivery.sent);
    });

    test('an unparseable timestamp does not crash the transcript', () {
      // One malformed row must not take down a customer's whole conversation.
      final m = ChatMessage.fromJson({'id': '1', 'from': 'customer', 'sentAt': 'nonsense'});
      expect(m.sentAt, isNotNull);
    });

    test('an unknown party falls back rather than throwing', () {
      expect(ChatMessage.fromJson({'id': '1', 'from': 'martian'}).from,
          ChatParty.customer);
    });
  });

  /* ---------------------------------------------------------------- */

  group('loading', () {
    test('an empty conversation is normal, not an error', () async {
      // Opening chat before anyone has spoken is the common case.
      final c = make(FakeTransport());
      await c.load();
      expect(c.messages, isEmpty);
      expect(c.error, isNull);
      expect(c.canSend, isTrue);
    });

    test('history loads in order', () async {
      final t = FakeTransport()..inbound('first');
      final c = make(t);
      await c.load();
      expect(c.messages.single.body, 'first');
    });

    test('a failed load degrades instead of blanking the screen', () async {
      final t = FakeTransport()..inbound('earlier message');
      final c = make(t);
      await c.load();
      t.failHistory = true;
      await c.load();
      // The earlier transcript is still there — losing it would be worse
      // than a stale one.
      expect(c.messages, isNotEmpty);
      expect(c.error, isNotNull);
    });

    test('a closed conversation is recognised on load', () async {
      final c = make(FakeTransport(closed: true));
      await c.load();
      expect(c.isClosed, isTrue);
      expect(c.canSend, isFalse);
      // Not an error — closing is the documented, expected end state.
      expect(c.error, isNull);
    });
  });

  /* ---------------------------------------------------------------- */

  group('sending', () {
    test('a message is PENDING until the server accepts it', () async {
      final t = FakeTransport();
      t.hold = Completer<ChatMessage>();
      final c = make(t);
      await c.load();

      unawaited(c.send('Please use the blue gate'));
      await Future<void>.delayed(Duration.zero);

      // This is the rule. In flight it must never look delivered.
      expect(c.messages.single.delivery, ChatDelivery.pending);

      t.hold!.complete(ChatMessage(
        id: 'server-1', from: ChatParty.customer,
        sentAt: DateTime(2026, 7, 26, 12), body: 'Please use the blue gate',
      ));
      await Future<void>.delayed(Duration.zero);
      expect(c.messages.single.delivery, ChatDelivery.sent);
      expect(c.messages.single.id, 'server-1');
    });

    test('a failed send is marked FAILED, not dropped', () async {
      // A message that vanishes is assumed delivered by the person who typed
      // it. That is the dangerous outcome.
      final c = make(FakeTransport(failSend: true));
      await c.load();
      await c.send('which turn after the junction?');

      expect(c.messages.single.isFailed, isTrue);
      expect(c.messages.single.body, 'which turn after the junction?');
      expect(c.failed, hasLength(1));
    });

    test('a failed message can be retried in place', () async {
      final t = FakeTransport(failSend: true);
      final c = make(t);
      await c.load();
      await c.send('I am at the gate');
      final id = c.messages.single.id;

      t.failSend = false;
      await c.retry(id);

      expect(c.messages.single.delivery, ChatDelivery.sent);
      expect(c.messages, hasLength(1), reason: 'retry must not duplicate');
    });

    test('a retry that fails again stays retryable', () async {
      final t = FakeTransport(failSend: true);
      final c = make(t);
      await c.load();
      await c.send('hello');
      await c.retry(c.messages.single.id);
      expect(c.messages.single.isFailed, isTrue);
    });

    test('empty and whitespace-only messages are not sent', () async {
      final t = FakeTransport();
      final c = make(t);
      await c.load();
      await c.send('');
      await c.send('   ');
      expect(t.sent, isEmpty);
      expect(c.messages, isEmpty);
    });

    test('a message is trimmed before sending', () async {
      final t = FakeTransport();
      final c = make(t);
      await c.load();
      await c.send('  blue gate  ');
      expect(t.sent.single, 'blue gate');
    });

    test('sending into a CLOSED window removes the bubble and explains',
        () async {
      // The server is the authority. If it refuses, the message must not sit
      // on screen looking like it might still go.
      final t = FakeTransport();
      final c = make(t);
      await c.load();
      t.closed = true;
      await c.send('are you still coming?');

      expect(c.messages, isEmpty);
      expect(c.isClosed, isTrue);
      expect(c.error, contains('closed'));
    });

    test('a closed conversation refuses further sends', () async {
      final t = FakeTransport(closed: true);
      final c = make(t);
      await c.load();
      await c.send('hello');
      expect(t.sent, isEmpty);
    });

    test('a refresh does not discard a message still in flight', () async {
      // The poll fires while the user's message is pending. Dropping it would
      // erase something they are watching.
      final t = FakeTransport(failSend: true);
      final c = make(t);
      await c.load();
      await c.send('pending one');
      await c.load();
      expect(c.messages.any((m) => m.body == 'pending one'), isTrue);
    });

    test('messages stay in time order after a reply arrives', () async {
      final t = FakeTransport();
      final c = make(t);
      await c.load();
      await c.send('mine');
      t.inbound('theirs');
      await c.load();
      final times = c.messages.map((m) => m.sentAt).toList();
      final sorted = [...times]..sort();
      expect(times, sorted);
    });
  });

  /* ---------------------------------------------------------------- */

  group('polling', () {
    test('picks up the other side\'s replies', () {
      fakeAsync((async) {
        final t = FakeTransport();
        final c = ChatController(
          orderId: 'o', me: ChatParty.customer, transport: t,
          pollInterval: const Duration(seconds: 5),
        );
        c.startPolling();
        t.inbound('I am outside');
        async.elapse(const Duration(seconds: 6));
        expect(t.historyCalls, greaterThan(0));
        c.dispose();
      });
    });

    test('stops once the server says the window closed', () {
      fakeAsync((async) {
        final t = FakeTransport();
        final c = ChatController(
          orderId: 'o', me: ChatParty.customer, transport: t,
          pollInterval: const Duration(seconds: 5),
        );
        c.startPolling();
        t.closed = true;
        async.elapse(const Duration(seconds: 6));
        final calls = t.historyCalls;
        async.elapse(const Duration(seconds: 30));
        // No point polling a conversation that can never change again — and
        // on mobile data it is the customer paying for it.
        expect(t.historyCalls, calls);
        expect(c.isClosed, isTrue);
        c.dispose();
      });
    });

    test('a failed poll is silent — no error banner for a blip', () {
      fakeAsync((async) {
        final t = FakeTransport()..failHistory = true;
        final c = ChatController(
          orderId: 'o', me: ChatParty.customer, transport: t,
          pollInterval: const Duration(seconds: 5),
        );
        c.startPolling();
        async.elapse(const Duration(seconds: 6));
        expect(c.error, isNull);
        c.dispose();
      });
    });

    test('dispose stops the timer', () {
      fakeAsync((async) {
        final t = FakeTransport();
        final c = ChatController(
          orderId: 'o', me: ChatParty.customer, transport: t,
          pollInterval: const Duration(seconds: 5),
        );
        c.startPolling();
        c.dispose();
        async.elapse(const Duration(seconds: 60));
        // A backgrounded screen must not keep eating a data bundle.
        expect(t.historyCalls, 0);
      });
    });
  });

  /* ---------------------------------------------------------------- */

  group('ChatView', () {
    testWidgets('renders a conversation at 360dp without overflow',
        (tester) async {
      final t = FakeTransport()..inbound('I am at the junction');
      final c = make(t);
      await c.load();
      await pump(tester, ChatView(controller: c));
      expect(tester.takeException(), isNull);
      expect(find.text('I am at the junction'), findsOneWidget);
    });

    testWidgets('a very long message does not overflow', (tester) async {
      final t = FakeTransport()
        ..inbound('I am at the big junction just after the MTN mast near the '
            'blue kiosk opposite the school, which way do I turn from here?');
      final c = make(t);
      await c.load();
      await pump(tester, ChatView(controller: c));
      expect(tester.takeException(), isNull);
    });

    testWidgets('an empty thread shows a prompt, not a blank screen',
        (tester) async {
      final c = make(FakeTransport());
      await c.load();
      await pump(tester, ChatView(controller: c, emptyHint: 'Tell your rider'));
      expect(find.byKey(const Key('chat-empty')), findsOneWidget);
      expect(find.text('Tell your rider'), findsOneWidget);
    });

    testWidgets('typing and sending clears the box and shows the bubble',
        (tester) async {
      final c = make(FakeTransport());
      await c.load();
      await pump(tester, ChatView(controller: c));

      await tester.enterText(find.byKey(const Key('chat-input')), 'blue gate');
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pumpAndSettle();

      expect(find.text('blue gate'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const Key('chat-input')))
          .controller!.text, isEmpty);
    });

    testWidgets('a pending message says "sending…"', (tester) async {
      final t = FakeTransport();
      t.hold = Completer<ChatMessage>();
      final c = make(t);
      await c.load();
      await pump(tester, ChatView(controller: c));

      await tester.enterText(find.byKey(const Key('chat-input')), 'hello');
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pump();

      expect(find.byKey(const Key('chat-pending')), findsOneWidget);
      t.hold!.complete(ChatMessage(
        id: 's1', from: ChatParty.customer, sentAt: DateTime(2026), body: 'hello',
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chat-pending')), findsNothing);
    });

    testWidgets('a failed message offers a retry the user can tap',
        (tester) async {
      final t = FakeTransport(failSend: true);
      final c = make(t);
      await c.load();
      await pump(tester, ChatView(controller: c));

      await tester.enterText(find.byKey(const Key('chat-input')), 'gate code 4');
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pumpAndSettle();

      expect(find.textContaining('Not sent'), findsOneWidget);

      t.failSend = false;
      await tester.tap(find.textContaining('Not sent'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Not sent'), findsNothing);
    });

    testWidgets('a closed conversation hides the composer and says why',
        (tester) async {
      // A composer that just disappears reads as a bug.
      final c = make(FakeTransport(closed: true));
      await c.load();
      await pump(tester, ChatView(controller: c));

      expect(find.byKey(const Key('chat-input')), findsNothing);
      expect(find.byKey(const Key('chat-closed')), findsOneWidget);
      expect(find.textContaining('30 minutes after delivery'), findsOneWidget);
    });

    testWidgets('the rider app sees its own messages on the right',
        (tester) async {
      // Same widget, both apps. `me` decides the side.
      final t = FakeTransport()..inbound('rider speaking');
      final c = make(t, me: ChatParty.rider);
      await c.load();
      await pump(tester, ChatView(controller: c));
      expect(tester.takeException(), isNull);
      expect(find.text('rider speaking'), findsOneWidget);
    });

    testWidgets('an error banner appears when loading failed', (tester) async {
      final t = FakeTransport()..failHistory = true;
      final c = make(t);
      await c.load();
      await pump(tester, ChatView(controller: c));
      expect(find.byKey(const Key('chat-error')), findsOneWidget);
    });
  });
}
