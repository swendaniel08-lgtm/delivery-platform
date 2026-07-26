/// Live delivery map.
///
/// This package deliberately does NOT depend on `google_maps_flutter`.
///
/// Not out of purity — a real map is the right long-term answer — but because
/// of what a pilot in Accra actually looks like:
///
///   • The Maps SDK costs a per-load fee on every screen open. A customer who
///     opens tracking eleven times while waiting is eleven billable loads,
///     and tile traffic on a Ghanaian mobile plan is the customer's money,
///     not ours.
///   • It adds ~8MB to the APK. That matters where people ration data and
///     phone storage.
///   • It needs a platform API key, Play Services, and a native build. Until
///     those keys exist the widget cannot even be exercised.
///
/// So the geometry, projection, camera and staleness handling all live here
/// behind [DeliveryMap], drawn on a Canvas with an optional tile layer. When
/// the Maps key arrives, [MapTileSource] is the single seam to implement —
/// everything above it, including every test below, stays unchanged.
///
/// The part that matters for a customer standing at a gate is not tile
/// photography. It is: where is my rider, which way are they moving, how far
/// away are they, and is this dot actually live.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:besonc_models/besonc_models.dart';

part 'src/map_projection.dart';

/* ------------------------------------------------------------------ */
/* Tile source seam                                                    */
/* ------------------------------------------------------------------ */

/// Where map imagery comes from, if anywhere.
///
/// The default is [NoTiles] — a clean rendered background. Swap in a real
/// implementation when the Maps key lands; nothing above this changes.
abstract class MapTileSource {
  /// Widget drawn behind the route and markers, sized to [size].
  Widget build(BuildContext context, MapCamera camera, Size size);
}

/// A drawn background: subtle grid, no imagery, no network, no cost.
class NoTiles implements MapTileSource {
  const NoTiles();

  @override
  Widget build(BuildContext context, MapCamera camera, Size size) =>
      CustomPaint(size: size, painter: _GridPainter(camera));
}

/* ------------------------------------------------------------------ */
/* The map                                                             */
/* ------------------------------------------------------------------ */

/// A live delivery map.
///
/// Shows the rider, the destination, the straight-line route between them,
/// and — crucially — whether the position on screen can still be trusted.
class DeliveryMap extends StatelessWidget {
  const DeliveryMap({
    super.key,
    required this.rider,
    required this.destination,
    this.pickup,
    this.trail = const <LatLng>[],
    this.etaSeconds,
    this.isStale = false,
    this.isVeryStale = false,
    this.riderLabel,
    this.height = 240,
    this.tiles = const NoTiles(),
    this.onRecentre,
  });

  /// Null before the first position arrives.
  final LatLng? rider;
  final LatLng destination;

  /// The vendor, when the rider has not collected yet.
  final LatLng? pickup;

  /// Recent positions, oldest first. Drawn as a fading breadcrumb.
  final List<LatLng> trail;

  final int? etaSeconds;

  /// The position is older than the live threshold.
  final bool isStale;

  /// Old enough that showing it as current would be a lie.
  final bool isVeryStale;

  final String? riderLabel;
  final double height;
  final MapTileSource tiles;
  final VoidCallback? onRecentre;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final size = Size(constraints.maxWidth, constraints.maxHeight);

          final points = <LatLng>[
            destination,
            if (rider != null) rider!,
            if (pickup != null) pickup!,
          ];
          final camera = MapCamera.fitting(points, size);

          return ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Stack(
              fit: StackFit.expand,
              children: [
                tiles.build(context, camera, size),

                CustomPaint(
                  size: size,
                  painter: _RoutePainter(
                    camera: camera,
                    rider: rider,
                    destination: destination,
                    pickup: pickup,
                    trail: trail,
                    // A stale dot is drawn hollow and grey. Showing a
                    // confident blue dot for a position from four minutes ago
                    // sends a customer to the gate too early — and then they
                    // blame the rider for being late when they were not.
                    stale: isStale || isVeryStale,
                  ),
                ),

                if (rider == null)
                  const _MapMessage(
                    key: Key('map-awaiting-position'),
                    icon: Icons.location_searching,
                    message: 'Locating your rider…',
                  )
                else if (isVeryStale)
                  const _MapMessage(
                    key: Key('map-position-lost'),
                    icon: Icons.signal_wifi_off,
                    // Named plainly. "Last seen" is honest; a moving dot
                    // driven by nothing is not.
                    message: 'Last known position — the rider’s phone is offline',
                  ),

                if (rider != null && !isVeryStale)
                  Positioned(
                    left: 8,
                    bottom: 8,
                    child: _DistanceChip(
                      key: const Key('map-distance'),
                      metres: haversineMetres(rider!, destination),
                      etaSeconds: etaSeconds,
                      stale: isStale,
                    ),
                  ),

                if (onRecentre != null)
                  Positioned(
                    right: 8,
                    bottom: 8,
                    child: _RecentreButton(onPressed: onRecentre!),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Painters                                                            */
/* ------------------------------------------------------------------ */

class _RoutePainter extends CustomPainter {
  _RoutePainter({
    required this.camera,
    required this.rider,
    required this.destination,
    required this.pickup,
    required this.trail,
    required this.stale,
  });

  final MapCamera camera;
  final LatLng? rider;
  final LatLng destination;
  final LatLng? pickup;
  final List<LatLng> trail;
  final bool stale;

  static const _live = Color(0xFF1B8A5A);
  static const _staleGrey = Color(0xFF8A8F98);
  static const _dest = Color(0xFFD64545);

  @override
  void paint(Canvas canvas, Size size) {
    final accent = stale ? _staleGrey : _live;

    // Breadcrumb, oldest faintest. It answers "which way are they going",
    // which a single dot cannot.
    if (trail.length > 1) {
      for (var i = 1; i < trail.length; i++) {
        final t = i / trail.length;
        canvas.drawLine(
          camera.toScreen(trail[i - 1]),
          camera.toScreen(trail[i]),
          Paint()
            ..color = accent.withValues(alpha: 0.15 + 0.45 * t)
            ..strokeWidth = 3
            ..strokeCap = StrokeCap.round,
        );
      }
    }

    if (rider != null) {
      _dashedLine(
        canvas,
        camera.toScreen(rider!),
        camera.toScreen(destination),
        Paint()
          ..color = accent.withValues(alpha: 0.5)
          ..strokeWidth = 2,
      );
    }

    if (pickup != null) {
      _pin(canvas, camera.toScreen(pickup!), const Color(0xFFE08A1E), Icons.store);
    }
    _pin(canvas, camera.toScreen(destination), _dest, Icons.home);

    if (rider != null) {
      _riderDot(canvas, camera.toScreen(rider!), accent, hollow: stale);
    }
  }

  /// Straight-line, not a road route: we have no polyline without Directions,
  /// and a fake curved road would imply knowledge we do not have.
  void _dashedLine(Canvas canvas, Offset a, Offset b, Paint paint) {
    const dash = 6.0, gap = 4.0;
    final total = (b - a).distance;
    if (total < 0.5) return;
    final step = (b - a) / total;
    var d = 0.0;
    while (d < total) {
      final end = math.min(d + dash, total);
      canvas.drawLine(a + step * d, a + step * end, paint);
      d = end + gap;
    }
  }

  void _pin(Canvas canvas, Offset at, Color colour, IconData icon) {
    canvas.drawCircle(at, 11, Paint()..color = Colors.white);
    canvas.drawCircle(at, 9, Paint()..color = colour);

    final tp = TextPainter(
      text: TextSpan(
        text: String.fromCharCode(icon.codePoint),
        style: TextStyle(
          fontSize: 11,
          fontFamily: icon.fontFamily,
          package: icon.fontPackage,
          color: Colors.white,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, at - Offset(tp.width / 2, tp.height / 2));
  }

  void _riderDot(Canvas canvas, Offset at, Color colour, {required bool hollow}) {
    if (!hollow) {
      canvas.drawCircle(at, 16, Paint()..color = colour.withValues(alpha: 0.18));
    }
    canvas.drawCircle(at, 9, Paint()..color = Colors.white);
    canvas.drawCircle(
      at,
      7,
      hollow
          // Hollow when stale — visibly different at a glance, not just a
          // slightly different shade that nobody notices.
          ? (Paint()
            ..color = colour
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2)
          : (Paint()..color = colour),
    );
  }

  @override
  bool shouldRepaint(_RoutePainter old) =>
      old.rider != rider ||
      old.destination != destination ||
      old.pickup != pickup ||
      old.stale != stale ||
      old.trail.length != trail.length;
}

class _GridPainter extends CustomPainter {
  _GridPainter(this.camera);
  final MapCamera camera;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(
      Offset.zero & size,
      Paint()..color = const Color(0xFFF2F4F6),
    );
    final line = Paint()
      ..color = const Color(0xFFE3E7EB)
      ..strokeWidth = 1;
    const spacing = 32.0;
    for (var x = 0.0; x < size.width; x += spacing) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), line);
    }
    for (var y = 0.0; y < size.height; y += spacing) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
    }
  }

  @override
  bool shouldRepaint(_GridPainter old) => false;
}

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */

class _MapMessage extends StatelessWidget {
  const _MapMessage({super.key, required this.icon, required this.message});
  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.94),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: const Color(0xFF5A616B)),
            const SizedBox(width: 8),
            // Flexible, not fixed: this string is long and 360dp is the
            // common phone width in Ghana.
            Flexible(
              child: Text(
                message,
                style: const TextStyle(fontSize: 12, color: Color(0xFF3A4048)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DistanceChip extends StatelessWidget {
  const _DistanceChip({
    super.key,
    required this.metres,
    required this.etaSeconds,
    required this.stale,
  });

  final double metres;
  final int? etaSeconds;
  final bool stale;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.94),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        // "about" is deliberate: this is straight-line distance, and Accra
        // traffic makes any precise-sounding number a promise we cannot keep.
        stale
            ? 'about ${formatDistance(metres)} away (last seen)'
            : 'about ${formatDistance(metres)} away'
                '${etaSeconds != null ? ' · ${formatEta(etaSeconds!)}' : ''}',
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: Color(0xFF23282F),
        ),
      ),
    );
  }
}

class _RecentreButton extends StatelessWidget {
  const _RecentreButton({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      shape: const CircleBorder(),
      child: InkWell(
        key: const Key('map-recentre'),
        customBorder: const CircleBorder(),
        onTap: onPressed,
        child: const Padding(
          padding: EdgeInsets.all(8),
          child: Icon(Icons.my_location, size: 18, color: Color(0xFF3A4048)),
        ),
      ),
    );
  }
}
