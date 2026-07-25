/// Besonc design system.
///
/// Constraints that shaped this, all of them Ghana-specific:
///
///   * Phones are used outdoors in strong sun, so contrast is high and
///     mid-greys are avoided for anything that carries meaning.
///   * Riders and vendors operate one-handed, often while moving, so the
///     primary action is a full-width 56px target — comfortably above the
///     48px accessibility minimum.
///   * Many devices are low-end, so there are no blurs, shadows-on-scroll
///     or animated gradients; those drop frames on a Tecno/Infinix.
///   * Everything degrades without images: menu photos frequently fail to
///     load on 3G, and a card must still be usable when they do.
library;

import 'package:flutter/material.dart';

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

abstract final class BesoncColors {
  /// Ghanaian flag green, darkened for AA contrast on white.
  static const brand = Color(0xFF00713F);
  static const brandDark = Color(0xFF00552F);
  static const brandSoft = Color(0xFFE6F2EC);

  static const ink = Color(0xFF11181C);
  static const inkMuted = Color(0xFF5B6770);
  static const line = Color(0xFFE1E6EA);
  static const surface = Color(0xFFFFFFFF);
  static const canvas = Color(0xFFF7F9FA);

  /// Semantic. Success is deliberately NOT the brand green, so "delivered"
  /// is never confused with a branded surface.
  static const success = Color(0xFF1A7F37);
  static const warning = Color(0xFFB35C00);
  static const danger = Color(0xFFC0272D);
  static const info = Color(0xFF0B5FA5);

  /// COD amounts always render in this colour across all three apps —
  /// cash is the highest-risk thing on the platform and must be unmissable.
  static const cash = Color(0xFF8A4B00);
}

abstract final class BesoncSpace {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  static const xxl = 32.0;
}

abstract final class BesoncRadius {
  static const sm = 6.0;
  static const md = 10.0;
  static const lg = 16.0;
  static const pill = 999.0;
}

/// Minimum tap target. Riders wear gloves and use one thumb at a junction.
const double kMinTap = 48.0;
const double kPrimaryActionHeight = 56.0;

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

ThemeData besoncTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: BesoncColors.brand,
    primary: BesoncColors.brand,
    error: BesoncColors.danger,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: BesoncColors.canvas,
    // System font: bundling a typeface adds ~400KB to an APK that people
    // download on metered data.
    fontFamily: null,
    appBarTheme: const AppBarTheme(
      backgroundColor: BesoncColors.surface,
      foregroundColor: BesoncColors.ink,
      elevation: 0,
      centerTitle: false,
    ),
    dividerTheme: const DividerThemeData(
      color: BesoncColors.line, thickness: 1, space: 1,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(kPrimaryActionHeight),
        backgroundColor: BesoncColors.brand,
        foregroundColor: Colors.white,
        disabledBackgroundColor: BesoncColors.line,
        disabledForegroundColor: BesoncColors.inkMuted,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(BesoncRadius.md),
        ),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(kMinTap),
        foregroundColor: BesoncColors.ink,
        side: const BorderSide(color: BesoncColors.line),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(BesoncRadius.md),
        ),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: BesoncColors.surface,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: BesoncSpace.lg, vertical: BesoncSpace.md,
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(BesoncRadius.md),
        borderSide: const BorderSide(color: BesoncColors.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(BesoncRadius.md),
        borderSide: const BorderSide(color: BesoncColors.line),
      ),
    ),
    cardTheme: CardThemeData(
      color: BesoncColors.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(BesoncRadius.lg),
        side: const BorderSide(color: BesoncColors.line),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/// Full-width primary action with a built-in busy state.
///
/// The busy state is part of the button rather than a separate overlay
/// because double-submission is the single most common way a customer
/// creates two orders on a slow connection.
class BesoncButton extends StatelessWidget {
  const BesoncButton({
    super.key,
    required this.label,
    this.onPressed,
    this.busy = false,
    this.danger = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final bool danger;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final disabled = busy || onPressed == null;
    return FilledButton(
      onPressed: disabled ? null : onPressed,
      style: danger
          ? FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(kPrimaryActionHeight),
              backgroundColor: BesoncColors.danger,
              foregroundColor: Colors.white,
            )
          : null,
      child: busy
          ? const SizedBox(
              height: 22, width: 22,
              child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white),
            )
          : Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 20),
                  const SizedBox(width: BesoncSpace.sm),
                ],
                Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
              ],
            ),
    );
  }
}

/// A short status label. `tone` carries the meaning; the text is never the
/// only signal, because colour alone fails for colour-blind users.
enum BesoncTone { neutral, brand, success, warning, danger, cash, info }

class BesoncBadge extends StatelessWidget {
  const BesoncBadge(this.text, {super.key, this.tone = BesoncTone.neutral, this.icon});

  final String text;
  final BesoncTone tone;
  final IconData? icon;

  Color get _fg => switch (tone) {
        BesoncTone.neutral => BesoncColors.inkMuted,
        BesoncTone.brand => BesoncColors.brandDark,
        BesoncTone.success => BesoncColors.success,
        BesoncTone.warning => BesoncColors.warning,
        BesoncTone.danger => BesoncColors.danger,
        BesoncTone.cash => BesoncColors.cash,
        BesoncTone.info => BesoncColors.info,
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: BesoncSpace.sm, vertical: BesoncSpace.xs,
      ),
      decoration: BoxDecoration(
        color: _fg.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(BesoncRadius.pill),
        border: Border.all(color: _fg.withValues(alpha: 0.28)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: _fg),
            const SizedBox(width: 4),
          ],
          Text(
            text,
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: _fg),
          ),
        ],
      ),
    );
  }
}

/// Money display. Cash amounts are always tinted so COD is unmissable.
class BesoncAmount extends StatelessWidget {
  const BesoncAmount(this.display, {super.key, this.isCash = false, this.large = false});

  final String display;
  final bool isCash;
  final bool large;

  @override
  Widget build(BuildContext context) {
    return Text(
      display,
      style: TextStyle(
        fontSize: large ? 22 : 15,
        fontWeight: FontWeight.w700,
        color: isCash ? BesoncColors.cash : BesoncColors.ink,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}

/// Image that degrades gracefully. Menu photos fail often on 3G, so the
/// fallback is a labelled placeholder rather than a broken-image icon.
class BesoncImage extends StatelessWidget {
  const BesoncImage({
    super.key, required this.url, required this.fallbackLabel,
    this.height = 120, this.width = double.infinity,
  });

  final String? url;
  final String fallbackLabel;
  final double height;
  final double width;

  @override
  Widget build(BuildContext context) {
    final placeholder = Container(
      height: height, width: width,
      color: BesoncColors.brandSoft,
      alignment: Alignment.center,
      child: Text(
        _initials(fallbackLabel),
        style: const TextStyle(
          fontSize: 20, fontWeight: FontWeight.w700, color: BesoncColors.brandDark,
        ),
      ),
    );

    if (url == null || url!.isEmpty) return placeholder;

    return Image.network(
      url!,
      height: height, width: width, fit: BoxFit.cover,
      errorBuilder: (_, __, ___) => placeholder,
      loadingBuilder: (_, child, progress) =>
          progress == null ? child : placeholder,
    );
  }

  static String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty);
    if (parts.isEmpty) return '?';
    return parts.take(2).map((p) => p[0].toUpperCase()).join();
  }
}

/// Empty and error states. Every failure gets an explanation and a way out —
/// a bare spinner that never resolves is the worst offline experience.
class BesoncEmpty extends StatelessWidget {
  const BesoncEmpty({
    super.key, required this.title, this.message, this.onRetry, this.icon,
  });

  final String title;
  final String? message;
  final VoidCallback? onRetry;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(BesoncSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon ?? Icons.inbox_outlined, size: 44, color: BesoncColors.inkMuted),
            const SizedBox(height: BesoncSpace.md),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
            if (message != null) ...[
              const SizedBox(height: BesoncSpace.sm),
              Text(
                message!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: BesoncColors.inkMuted),
              ),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: BesoncSpace.lg),
              OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
            ],
          ],
        ),
      ),
    );
  }
}

/// Skeleton placeholder. Static, not shimmering — animated shimmer costs
/// frames on the low-end devices most of our customers carry.
class BesoncSkeleton extends StatelessWidget {
  const BesoncSkeleton({super.key, this.height = 16, this.width = double.infinity});
  final double height;
  final double width;

  @override
  Widget build(BuildContext context) => Container(
        height: height, width: width,
        decoration: BoxDecoration(
          color: BesoncColors.line,
          borderRadius: BorderRadius.circular(BesoncRadius.sm),
        ),
      );
}

/// A banner explaining why something is unavailable, with an optional action.
class BesoncNotice extends StatelessWidget {
  const BesoncNotice({
    super.key, required this.message, this.tone = BesoncTone.info,
    this.actionLabel, this.onAction,
  });

  final String message;
  final BesoncTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  Color get _c => switch (tone) {
        BesoncTone.danger => BesoncColors.danger,
        BesoncTone.warning => BesoncColors.warning,
        BesoncTone.success => BesoncColors.success,
        BesoncTone.cash => BesoncColors.cash,
        _ => BesoncColors.info,
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(BesoncSpace.md),
      decoration: BoxDecoration(
        color: _c.withValues(alpha: 0.08),
        border: Border.all(color: _c.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(BesoncRadius.md),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline, size: 18, color: _c),
          const SizedBox(width: BesoncSpace.sm),
          Expanded(
            child: Text(message, style: TextStyle(color: _c, fontSize: 13.5)),
          ),
          if (actionLabel != null && onAction != null)
            TextButton(
              onPressed: onAction,
              child: Text(actionLabel!, style: TextStyle(color: _c)),
            ),
        ],
      ),
    );
  }
}
