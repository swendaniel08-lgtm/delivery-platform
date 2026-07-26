/// Live delivery map: geometry, camera and the honesty rules.
///
/// The projection tests use real Accra coordinates, because a latitude/
/// longitude swap or a missing cosine correction produces numbers that look
/// plausible in the abstract and are badly wrong on a map of Ghana.
///
/// The widget tests all run at 360x740 — the phone size most common in Ghana
/// and the one that has repeatedly exposed overflow bugs that the 800x600
/// test default hides completely.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:besonc_models/besonc_models.dart';
import 'package:besonc_tracking/besonc_tracking.dart';

/* Real places, so a swapped axis is obvious. */
const osu = LatLng(5.5560, -0.1821);
const accraMall = LatLng(5.6206, -0.1730);
const labadi = LatLng(5.5580, -0.1560);

const phone = Size(360, 740);

Future<void> pumpMap(WidgetTester tester, Widget child) async {
  await tester.binding.setSurfaceSize(phone);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: child)));
}

void main() {
  /* ---------------------------------------------------------------- */

  group('distance', () {
    test('Osu to Accra Mall is about 7.3 km', () {
      final km = haversineMetres(osu, accraMall) / 1000;
      expect(km, greaterThan(6.5));
      expect(km, lessThan(8.5));
    });

    test('a point is zero metres from itself', () {
      expect(haversineMetres(osu, osu), lessThan(0.01));
    });

    test('distance is symmetric', () {
      expect(
        (haversineMetres(osu, accraMall) - haversineMetres(accraMall, osu)).abs(),
        lessThan(0.01),
      );
    });

    test('a swapped lat/lng would be caught', () {
      // The whole reason these use real coordinates. Osu with its axes
      // swapped is in the Gulf of Guinea, hundreds of km away.
      final swapped = LatLng(osu.lng, osu.lat);
      expect(haversineMetres(osu, swapped), greaterThan(500000));
    });

    test('short distances stay accurate', () {
      // ~111 m north. This is fence-radius scale, where the maths has to be
      // right or geofences fire in the wrong place.
      const north = LatLng(5.5570, -0.1821);
      final m = haversineMetres(osu, north);
      expect(m, greaterThan(100));
      expect(m, lessThan(125));
    });
  });

  /* ---------------------------------------------------------------- */

  group('distance formatting', () {
    test('rounds hard, because the precision is not real', () {
      // A phone GPS fix plus a straight line does not justify metre precision.
      expect(formatDistance(47), '50 m');
      expect(formatDistance(230), '250 m');
      expect(formatDistance(1247), '1.2 km');
      expect(formatDistance(15400), '15 km');
    });

    test('never renders a bare number without a unit', () {
      for (final m in [0.0, 9.0, 99.0, 999.0, 9999.0, 99999.0]) {
        expect(formatDistance(m), anyOf(contains(' m'), contains(' km')));
      }
    });
  });

  group('ETA formatting', () {
    test('never counts down to zero', () {
      // Someone is standing at a gate. "0 min" while nobody is there is
      // worse than saying nothing.
      expect(formatEta(0), 'arriving');
      expect(formatEta(-30), 'arriving');
    });

    test('rounds up — early is a broken promise', () {
      expect(formatEta(61), '2 min');
      expect(formatEta(119), '2 min');
    });

    test('handles long waits', () {
      expect(formatEta(3600), '1 h');
      expect(formatEta(5400), '1 h 30 min');
    });
  });

  /* ---------------------------------------------------------------- */

  group('camera', () {
    test('centres between the points it must fit', () {
      final cam = MapCamera.fitting([osu, accraMall], phone);
      expect(cam.centre.lat, closeTo((osu.lat + accraMall.lat) / 2, 1e-9));
      expect(cam.centre.lng, closeTo((osu.lng + accraMall.lng) / 2, 1e-9));
    });

    test('every fitted point lands on screen', () {
      final cam = MapCamera.fitting([osu, accraMall, labadi], phone);
      for (final p in [osu, accraMall, labadi]) {
        expect(cam.contains(p), isTrue, reason: '$p fell outside the viewport');
      }
    });

    test('north is up', () {
      // Latitude grows northward, screen Y grows downward. Getting this
      // backwards flips the whole map and nobody notices until a rider
      // appears to drive away from the customer.
      final cam = MapCamera.fitting([osu, accraMall], phone);
      expect(cam.toScreen(accraMall).dy, lessThan(cam.toScreen(osu).dy));
    });

    test('east is right', () {
      final cam = MapCamera.fitting([osu, labadi], phone);
      expect(cam.toScreen(labadi).dx, greaterThan(cam.toScreen(osu).dx));
    });

    test('screen and geographic coordinates round-trip', () {
      final cam = MapCamera.fitting([osu, accraMall], phone);
      final back = cam.toLatLng(cam.toScreen(osu));
      expect(back.lat, closeTo(osu.lat, 1e-9));
      expect(back.lng, closeTo(osu.lng, 1e-9));
    });

    test('longitude is cosine-corrected for latitude', () {
      // Without the correction a degree of longitude would be drawn the same
      // width as a degree of latitude, stretching every route east-west.
      final cam = MapCamera.fitting([osu], phone);
      const oneDegNorth = LatLng(6.5560, -0.1821);
      const oneDegEast = LatLng(5.5560, 0.8179);

      final north = (cam.toScreen(oneDegNorth) - cam.toScreen(osu)).distance;
      final east = (cam.toScreen(oneDegEast) - cam.toScreen(osu)).distance;

      // At 5.5 degrees N, cos ~= 0.9953, so east must be slightly shorter.
      expect(east, lessThan(north));
      expect(east / north, closeTo(0.995, 0.01));
    });

    test('a single point does not divide by zero', () {
      final cam = MapCamera.fitting([osu], phone);
      expect(cam.metresPerPixel, greaterThan(0));
      expect(cam.toScreen(osu).dx, closeTo(180, 0.001));
    });

    test('no points falls back to Accra rather than null island', () {
      // (0,0) is in the Atlantic. Defaulting there would put a Ghanaian
      // delivery app 600 km out to sea.
      final cam = MapCamera.fitting([], phone);
      expect(cam.centre.lat, closeTo(5.6037, 0.01));
      expect(cam.centre.lng, closeTo(-0.1870, 0.01));
    });

    test('zoom is clamped when the rider is metres from the door', () {
      // Fitting exactly would zoom to street-furniture scale and the two
      // pins would overlap into one blob.
      const almostThere = LatLng(5.55601, -0.18211);
      final cam = MapCamera.fitting([osu, almostThere], phone);
      expect(cam.metresPerPixel, greaterThanOrEqualTo(0.6));
    });

    test('zoom is clamped when the points are absurdly far apart', () {
      final cam = MapCamera.fitting([osu, const LatLng(9.4, -0.85)], phone);
      expect(cam.metresPerPixel, lessThanOrEqualTo(60.0));
    });
  });

  /* ---------------------------------------------------------------- */

  group('DeliveryMap', () {
    testWidgets('renders at 360dp with no overflow', (tester) async {
      await pumpMap(tester, const DeliveryMap(
        rider: osu, destination: accraMall, etaSeconds: 480,
      ));
      expect(tester.takeException(), isNull);
      expect(find.byType(DeliveryMap), findsOneWidget);
    });

    testWidgets('shows the distance and ETA', (tester) async {
      await pumpMap(tester, const DeliveryMap(
        rider: osu, destination: accraMall, etaSeconds: 480,
      ));
      final chip = tester.widget<Text>(
        find.descendant(of: find.byKey(const Key('map-distance')), matching: find.byType(Text)),
      );
      // "about" matters: this is straight-line distance and must never read
      // as a precise promise.
      expect(chip.data, contains('about'));
      expect(chip.data, contains('km'));
      expect(chip.data, contains('8 min'));
    });

    testWidgets('says it is LOCATING before the first position', (tester) async {
      // Not an empty map. A blank grid looks like a broken app.
      await pumpMap(tester, const DeliveryMap(rider: null, destination: accraMall));
      expect(find.byKey(const Key('map-awaiting-position')), findsOneWidget);
      expect(find.byKey(const Key('map-distance')), findsNothing);
    });

    testWidgets('a STALE position still shows, marked as last seen',
        (tester) async {
      // Degraded, not hidden: the last known position is genuinely useful.
      await pumpMap(tester, const DeliveryMap(
        rider: osu, destination: accraMall, isStale: true,
      ));
      final chip = tester.widget<Text>(
        find.descendant(of: find.byKey(const Key('map-distance')), matching: find.byType(Text)),
      );
      expect(chip.data, contains('last seen'));
    });

    testWidgets('a VERY stale position says the phone is offline',
        (tester) async {
      // The honesty rule. A confident dot from four minutes ago sends a
      // customer to the gate too early, and then the rider gets blamed.
      await pumpMap(tester, const DeliveryMap(
        rider: osu, destination: accraMall, isStale: true, isVeryStale: true,
      ));
      expect(find.byKey(const Key('map-position-lost')), findsOneWidget);
      expect(find.textContaining('Last known position'), findsOneWidget);
      expect(find.byKey(const Key('map-distance')), findsNothing);
    });

    testWidgets('the offline message does not overflow at 360dp',
        (tester) async {
      // It is a long string in a constrained pill. This is exactly the shape
      // of the five overflow bugs already found on this width.
      await pumpMap(tester, const DeliveryMap(
        rider: osu, destination: accraMall, isVeryStale: true,
      ));
      expect(tester.takeException(), isNull);
    });

    testWidgets('the recentre button appears only when it does something',
        (tester) async {
      await pumpMap(tester, const DeliveryMap(rider: osu, destination: accraMall));
      expect(find.byKey(const Key('map-recentre')), findsNothing);

      var tapped = false;
      await pumpMap(tester, DeliveryMap(
        rider: osu, destination: accraMall, onRecentre: () => tapped = true,
      ));
      await tester.tap(find.byKey(const Key('map-recentre')));
      expect(tapped, isTrue);
    });

    testWidgets('renders a pickup pin when the rider has not collected',
        (tester) async {
      await pumpMap(tester, const DeliveryMap(
        rider: labadi, destination: accraMall, pickup: osu,
      ));
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders a breadcrumb trail without error', (tester) async {
      await pumpMap(tester, const DeliveryMap(
        rider: accraMall,
        destination: labadi,
        trail: [osu, LatLng(5.58, -0.178), accraMall],
      ));
      expect(tester.takeException(), isNull);
    });

    testWidgets('survives a rider exactly on the destination', (tester) async {
      // Zero distance, zero span. A naive fit divides by zero here.
      await pumpMap(tester, const DeliveryMap(
        rider: accraMall, destination: accraMall, etaSeconds: 0,
      ));
      expect(tester.takeException(), isNull);
      final chip = tester.widget<Text>(
        find.descendant(of: find.byKey(const Key('map-distance')), matching: find.byType(Text)),
      );
      expect(chip.data, contains('arriving'));
    });

    testWidgets('renders in a very short container', (tester) async {
      await pumpMap(tester, const DeliveryMap(
        rider: osu, destination: accraMall, height: 80,
      ));
      expect(tester.takeException(), isNull);
    });

    testWidgets('omits the ETA when the server did not send one',
        (tester) async {
      // An invented ETA is worse than none.
      await pumpMap(tester, const DeliveryMap(rider: osu, destination: accraMall));
      final chip = tester.widget<Text>(
        find.descendant(of: find.byKey(const Key('map-distance')), matching: find.byType(Text)),
      );
      expect(chip.data, isNot(contains('min')));
      expect(chip.data, contains('away'));
    });
  });
}
