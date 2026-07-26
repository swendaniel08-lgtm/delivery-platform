part of '../besonc_tracking.dart';

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const double _earthRadiusMetres = 6371000.0;

/// Great-circle distance in metres.
///
/// Straight-line, not road distance. Every caller must present it as
/// approximate — Accra traffic and one-way streets mean the road figure is
/// routinely 1.3–1.6x this, and a precise-sounding number is a promise the
/// app cannot keep.
double haversineMetres(LatLng a, LatLng b) {
  final dLat = _radians(b.lat - a.lat);
  final dLng = _radians(b.lng - a.lng);
  final lat1 = _radians(a.lat);
  final lat2 = _radians(b.lat);

  final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1) * math.cos(lat2) * math.sin(dLng / 2) * math.sin(dLng / 2);
  return 2 * _earthRadiusMetres * math.asin(math.min(1.0, math.sqrt(h)));
}

double _radians(double deg) => deg * math.pi / 180.0;

/// Distance for a customer to read.
///
/// Rounded hard on purpose: "1.2 km" is useful, "1,247 m" implies a precision
/// that a phone GPS fix and a straight line do not have.
String formatDistance(double metres) {
  if (metres < 100) return '${(metres / 10).round() * 10} m';
  if (metres < 1000) return '${(metres / 50).round() * 50} m';
  if (metres < 10000) return '${(metres / 1000).toStringAsFixed(1)} km';
  return '${(metres / 1000).round()} km';
}

/// ETA for a customer to read.
///
/// Never "0 min" — a rider who has not arrived has not arrived, and counting
/// down to zero while someone stands at a gate is worse than saying nothing.
String formatEta(int seconds) {
  if (seconds <= 0) return 'arriving';
  final minutes = (seconds / 60).ceil();
  if (minutes < 60) return '$minutes min';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest == 0 ? '$hours h' : '$hours h $rest min';
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/// Maps lat/lng onto screen pixels for a fixed viewport.
///
/// Equirectangular with a cosine correction on longitude. Over the few
/// kilometres a delivery covers this is visually indistinguishable from a
/// proper Mercator projection, and it stays invertible and trivially testable.
/// The cosine term is not optional: without it, at Accra's latitude every
/// route would render stretched east–west by about 0.5%, and further from the
/// equator it becomes badly wrong.
@immutable
class MapCamera {
  const MapCamera({
    required this.centre,
    required this.metresPerPixel,
    required this.size,
  });

  final LatLng centre;
  final double metresPerPixel;
  final Size size;

  /// A camera that fits every point with a comfortable margin.
  ///
  /// The minimum zoom floor matters: when the rider is 20 m from the door,
  /// fitting exactly would zoom to street-furniture scale and the two pins
  /// would sit on top of each other. Clamping keeps the picture legible.
  factory MapCamera.fitting(
    List<LatLng> points,
    Size size, {
    double paddingFraction = 0.18,
    double minMetresPerPixel = 0.6,
    double maxMetresPerPixel = 60.0,
  }) {
    if (points.isEmpty) {
      return MapCamera(
        centre: const LatLng(5.6037, -0.1870), // Accra
        metresPerPixel: 4,
        size: size,
      );
    }

    var minLat = points.first.lat, maxLat = points.first.lat;
    var minLng = points.first.lng, maxLng = points.first.lng;
    for (final p in points) {
      minLat = math.min(minLat, p.lat);
      maxLat = math.max(maxLat, p.lat);
      minLng = math.min(minLng, p.lng);
      maxLng = math.max(maxLng, p.lng);
    }

    final centre = LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2);

    final spanNS = haversineMetres(LatLng(minLat, centre.lng), LatLng(maxLat, centre.lng));
    final spanEW = haversineMetres(LatLng(centre.lat, minLng), LatLng(centre.lat, maxLng));

    final usableW = math.max(1.0, size.width * (1 - 2 * paddingFraction));
    final usableH = math.max(1.0, size.height * (1 - 2 * paddingFraction));

    final mpp = math.max(
      spanEW / usableW,
      spanNS / usableH,
    );

    return MapCamera(
      centre: centre,
      metresPerPixel: mpp.clamp(minMetresPerPixel, maxMetresPerPixel).toDouble(),
      size: size,
    );
  }

  double get _metresPerDegreeLat => _earthRadiusMetres * math.pi / 180.0;
  double get _metresPerDegreeLng =>
      _metresPerDegreeLat * math.cos(_radians(centre.lat));

  /// Geographic position to a pixel offset. Y grows downward on screen while
  /// latitude grows northward, hence the negation.
  Offset toScreen(LatLng p) {
    final dxMetres = (p.lng - centre.lng) * _metresPerDegreeLng;
    final dyMetres = (p.lat - centre.lat) * _metresPerDegreeLat;
    return Offset(
      size.width / 2 + dxMetres / metresPerPixel,
      size.height / 2 - dyMetres / metresPerPixel,
    );
  }

  /// Inverse of [toScreen] — needed the moment the map accepts a tap.
  LatLng toLatLng(Offset px) {
    final dxMetres = (px.dx - size.width / 2) * metresPerPixel;
    final dyMetres = (size.height / 2 - px.dy) * metresPerPixel;
    return LatLng(
      centre.lat + dyMetres / _metresPerDegreeLat,
      centre.lng + dxMetres / _metresPerDegreeLng,
    );
  }

  /// True when a point would land inside the viewport.
  bool contains(LatLng p) {
    final o = toScreen(p);
    return o.dx >= 0 && o.dx <= size.width && o.dy >= 0 && o.dy <= size.height;
  }
}
