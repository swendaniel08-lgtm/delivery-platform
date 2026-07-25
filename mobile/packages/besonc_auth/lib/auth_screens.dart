/// The sign-in screens, shared by all three apps.
///
/// Designed for the phones Besonc actually runs on: 360dp-wide Androids,
/// often in bright sunlight, often on 3G. Hence large tap targets, high
/// contrast, and no animation that hides whether a tap registered.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:besonc_ui/besonc_ui.dart';

import 'besonc_auth.dart';

/// Switches between phone entry, code entry and a splash while restoring.
class AuthGate extends StatelessWidget {
  const AuthGate({
    super.key,
    required this.auth,
    required this.child,
    this.tagline,
  });

  final AuthController auth;

  /// Shown once authenticated.
  final Widget child;
  final String? tagline;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: auth,
      builder: (context, _) => switch (auth.stage) {
        AuthStage.restoring => const _Splash(),
        AuthStage.phoneEntry => PhoneEntryScreen(auth: auth, tagline: tagline),
        AuthStage.codeEntry => CodeEntryScreen(auth: auth),
        AuthStage.authenticated => child,
      },
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) => const Scaffold(
        key: Key('auth-splash'),
        backgroundColor: BesoncColors.canvas,
        body: Center(child: CircularProgressIndicator()),
      );
}

/* ------------------------------------------------------------------ */

class PhoneEntryScreen extends StatefulWidget {
  const PhoneEntryScreen({super.key, required this.auth, this.tagline});

  final AuthController auth;
  final String? tagline;

  @override
  State<PhoneEntryScreen> createState() => _PhoneEntryScreenState();
}

class _PhoneEntryScreenState extends State<PhoneEntryScreen> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Subscribe here rather than relying on AuthGate: these screens are also
    // pushed directly (deep links, "sign in to continue"), and a screen that
    // silently stops repainting is the worst kind of bug to chase.
    return AnimatedBuilder(
      animation: widget.auth,
      builder: (context, _) => _build(context),
    );
  }

  Widget _build(BuildContext context) {
    final auth = widget.auth;
    final phoneError = auth.fieldErrors?['phone']?.first;

    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      body: SafeArea(
        child: SingleChildScrollView(
          // The keyboard covers half a 360dp screen; without this the
          // Continue button is unreachable.
          padding: EdgeInsets.only(
            left: BesoncSpace.lg,
            right: BesoncSpace.lg,
            top: BesoncSpace.xl,
            bottom: MediaQuery.of(context).viewInsets.bottom + BesoncSpace.lg,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: BesoncSpace.xl),
              const Text(
                'Besonc',
                key: Key('auth-wordmark'),
                style: TextStyle(
                  fontSize: 34, fontWeight: FontWeight.w800,
                  color: BesoncColors.brandDark,
                ),
              ),
              const SizedBox(height: BesoncSpace.xs),
              Text(
                widget.tagline ?? 'Everything delivered, across Ghana.',
                style: const TextStyle(color: BesoncColors.inkMuted, fontSize: 15),
              ),
              const SizedBox(height: BesoncSpace.xxl),

              const Text('Mobile number',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: BesoncSpace.sm),
              TextField(
                key: const Key('phone-field'),
                controller: _controller,
                keyboardType: TextInputType.phone,
                autofillHints: const [AutofillHints.telephoneNumber],
                inputFormatters: [
                  // Digits, plus and spaces only — everything else is a typo.
                  FilteringTextInputFormatter.allow(RegExp(r'[\d +]')),
                  LengthLimitingTextInputFormatter(17),
                ],
                decoration: InputDecoration(
                  hintText: '024 412 3456',
                  prefixIcon: const Icon(Icons.phone_outlined),
                  errorText: phoneError,
                ),
                onSubmitted: (_) => _submit(),
              ),
              const SizedBox(height: BesoncSpace.md),

              if (auth.error != null && phoneError == null) ...[
                BesoncNotice(message: auth.error!, tone: BesoncTone.danger),
                const SizedBox(height: BesoncSpace.md),
              ],

              BesoncButton(
                key: const Key('phone-continue'),
                label: 'Continue',
                busy: auth.busy,
                onPressed: _submit,
              ),
              const SizedBox(height: BesoncSpace.md),
              const Text(
                'We will text you a 6-digit code. Standard SMS rates may apply.',
                textAlign: TextAlign.center,
                style: TextStyle(color: BesoncColors.inkMuted, fontSize: 12.5),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _submit() {
    if (widget.auth.busy) return;
    widget.auth.requestCode(_controller.text);
  }
}

/* ------------------------------------------------------------------ */

class CodeEntryScreen extends StatefulWidget {
  const CodeEntryScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  State<CodeEntryScreen> createState() => _CodeEntryScreenState();
}

class _CodeEntryScreenState extends State<CodeEntryScreen> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    // In test/staging the backend hands back the code; prefill so QA and
    // the integration suite are not blocked on a real SMS.
    final debug = widget.auth.debugCode;
    if (debug != null) _controller.text = debug;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: widget.auth,
        builder: (context, _) => _build(context),
      );

  Widget _build(BuildContext context) {
    final auth = widget.auth;
    final codeError = auth.fieldErrors?['code']?.first;
    final phone = auth.pendingPhone ?? '';

    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      appBar: AppBar(
        leading: IconButton(
          key: const Key('code-back'),
          icon: const Icon(Icons.arrow_back),
          onPressed: auth.changeNumber,
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: EdgeInsets.only(
            left: BesoncSpace.lg,
            right: BesoncSpace.lg,
            bottom: MediaQuery.of(context).viewInsets.bottom + BesoncSpace.lg,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Enter your code',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
              const SizedBox(height: BesoncSpace.xs),
              Text(
                'Sent to ${formatGhanaPhone(phone)}',
                key: const Key('code-destination'),
                style: const TextStyle(color: BesoncColors.inkMuted),
              ),
              const SizedBox(height: BesoncSpace.xl),

              TextField(
                key: const Key('code-field'),
                controller: _controller,
                keyboardType: TextInputType.number,
                autofocus: true,
                textAlign: TextAlign.center,
                maxLength: 6,
                style: const TextStyle(
                  fontSize: 30, fontWeight: FontWeight.w700, letterSpacing: 10,
                ),
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(
                  counterText: '',
                  hintText: '000000',
                  errorText: codeError,
                ),
                onChanged: (v) {
                  // Auto-submit on the sixth digit: nobody should have to
                  // find a button after typing a code they just read.
                  if (v.length == 6 && !auth.busy) auth.verifyCode(v);
                },
              ),
              const SizedBox(height: BesoncSpace.md),

              if (auth.error != null && codeError == null) ...[
                BesoncNotice(message: auth.error!, tone: BesoncTone.danger),
                const SizedBox(height: BesoncSpace.md),
              ],

              BesoncButton(
                key: const Key('code-verify'),
                label: 'Verify',
                busy: auth.busy,
                onPressed: () => auth.verifyCode(_controller.text),
              ),
              const SizedBox(height: BesoncSpace.md),

              Center(
                child: TextButton(
                  key: const Key('code-resend'),
                  onPressed: auth.canResend ? auth.resendCode : null,
                  child: Text(
                    auth.canResend
                        ? 'Resend code'
                        : 'Resend code in ${auth.resendInSeconds}s',
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */

/// Shown once, immediately after a brand-new account is created.
class ProfileSetupScreen extends StatefulWidget {
  const ProfileSetupScreen({super.key, required this.auth, this.onDone});

  final AuthController auth;
  final VoidCallback? onDone;

  @override
  State<ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<ProfileSetupScreen> {
  final _first = TextEditingController();
  final _last = TextEditingController();

  @override
  void dispose() {
    _first.dispose();
    _last.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: widget.auth,
        builder: (context, _) => _build(context),
      );

  Widget _build(BuildContext context) {
    final auth = widget.auth;
    return Scaffold(
      backgroundColor: BesoncColors.canvas,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: EdgeInsets.only(
            left: BesoncSpace.lg,
            right: BesoncSpace.lg,
            top: BesoncSpace.xl,
            bottom: MediaQuery.of(context).viewInsets.bottom + BesoncSpace.lg,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('What should we call you?',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
              const SizedBox(height: BesoncSpace.xs),
              const Text(
                'Riders and vendors see your first name on an order.',
                style: TextStyle(color: BesoncColors.inkMuted),
              ),
              const SizedBox(height: BesoncSpace.xl),
              TextField(
                key: const Key('first-name-field'),
                controller: _first,
                textCapitalization: TextCapitalization.words,
                decoration: InputDecoration(
                  labelText: 'First name',
                  errorText: auth.fieldErrors?['firstName']?.first,
                ),
              ),
              const SizedBox(height: BesoncSpace.md),
              TextField(
                key: const Key('last-name-field'),
                controller: _last,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(labelText: 'Last name (optional)'),
              ),
              const SizedBox(height: BesoncSpace.lg),
              if (auth.error != null) ...[
                BesoncNotice(message: auth.error!, tone: BesoncTone.danger),
                const SizedBox(height: BesoncSpace.md),
              ],
              BesoncButton(
                key: const Key('profile-save'),
                label: 'Continue',
                busy: auth.busy,
                onPressed: () async {
                  final ok = await auth.saveProfile(
                    firstName: _first.text, lastName: _last.text,
                  );
                  if (ok) widget.onDone?.call();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
