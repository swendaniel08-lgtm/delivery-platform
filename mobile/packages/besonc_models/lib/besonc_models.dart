/// Shared domain models for all three Besonc apps.
///
/// Money rule, mirroring the backend: amounts are integer PESEWAS held in an
/// `int`, never a `double`. Dart's `int` is 64-bit on mobile, so this is safe
/// well past any plausible order value. The wire format is a decimal STRING
/// because JSON numbers lose precision above 2^53.
library;

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/// Integer pesewas. 100 pesewas = GHS 1.
extension type const Pesewas(int value) {
  static Pesewas parse(String wire) => Pesewas(int.parse(wire));

  /// Tolerant of nulls from optional wire fields.
  static Pesewas? tryParse(String? wire) =>
      wire == null ? null : Pesewas(int.parse(wire));

  Pesewas operator +(Pesewas other) => Pesewas(value + other.value);
  Pesewas operator -(Pesewas other) => Pesewas(value - other.value);
  Pesewas operator *(int qty) => Pesewas(value * qty);
  bool operator >(Pesewas other) => value > other.value;
  bool operator <(Pesewas other) => value < other.value;

  String get wire => value.toString();

  /// Display form, matching `libs/money/formatCedis` exactly:
  /// thousand separators, sign after the currency.
  String get display {
    final negative = value < 0;
    final abs = value.abs();
    final whole = (abs ~/ 100).toString().replaceAllMapped(
          RegExp(r'\B(?=(\d{3})+(?!\d))'),
          (m) => ',',
        );
    final frac = (abs % 100).toString().padLeft(2, '0');
    return 'GHS ${negative ? '-' : ''}$whole.$frac';
  }
}

/* ------------------------------------------------------------------ */
/* Geography                                                           */
/* ------------------------------------------------------------------ */

class LatLng {
  const LatLng(this.lat, this.lng);
  final double lat;
  final double lng;

  factory LatLng.fromJson(Map<String, dynamic> j) =>
      LatLng((j['lat'] as num).toDouble(), (j['lng'] as num).toDouble());

  Map<String, dynamic> toJson() => {'lat': lat, 'lng': lng};

  @override
  String toString() => '$lat,$lng';
}

/// A Ghanaian delivery address: the GPS pin is authoritative, everything
/// else helps a rider actually find the gate.
class Address {
  const Address({
    required this.id,
    required this.label,
    required this.position,
    this.areaName,
    this.landmark,
    this.instructions,
    this.ghanaPostAddress,
    this.isDefault = false,
  });

  final String id;
  final String label;
  final LatLng position;
  final String? areaName;

  /// "behind the MTN mast, blue gate" — in practice this is what gets used.
  final String? landmark;
  final String? instructions;
  final String? ghanaPostAddress;
  final bool isDefault;

  factory Address.fromJson(Map<String, dynamic> j) => Address(
        id: j['id'] as String,
        label: j['label'] as String? ?? 'Address',
        position: LatLng(
          (j['lat'] as num).toDouble(),
          (j['lng'] as num).toDouble(),
        ),
        areaName: j['areaName'] as String?,
        landmark: j['landmark'] as String?,
        instructions: j['instructions'] as String?,
        ghanaPostAddress: j['ghanapostAddress'] as String?,
        isDefault: j['isDefault'] as bool? ?? false,
      );

  /// What the customer sees in the address bar.
  String get shortDisplay => landmark?.isNotEmpty == true
      ? '$label — $landmark'
      : (areaName ?? label);
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

enum ServiceType {
  food, groceries, market, shop, pharmacy, laundry, parcel, errand;

  static ServiceType fromWire(String s) => ServiceType.values.firstWhere(
        (v) => v.name == s,
        orElse: () => ServiceType.food,
      );

  String get label => switch (this) {
        ServiceType.food => 'Food',
        ServiceType.groceries => 'Groceries',
        ServiceType.market => 'Market',
        ServiceType.shop => 'Shop',
        ServiceType.pharmacy => 'Pharmacy',
        ServiceType.laundry => 'Laundry',
        ServiceType.parcel => 'Parcel',
        ServiceType.errand => 'Errand',
      };
}

class ServiceTile {
  const ServiceTile({required this.key, required this.label, required this.enabled});
  final String key;
  final String label;
  final bool enabled;

  factory ServiceTile.fromJson(Map<String, dynamic> j) => ServiceTile(
        key: j['key'] as String,
        label: j['label'] as String,
        enabled: j['enabled'] as bool? ?? false,
      );
}

class StoreCard {
  const StoreCard({
    required this.id,
    required this.name,
    required this.rating,
    required this.prepEstimate,
    required this.deliveryFee,
    required this.isOpen,
    this.imageUrl,
    this.opensAt,
  });

  final String id;
  final String name;
  final double rating;
  final String prepEstimate;   // "25-35 min"
  final String deliveryFee;    // preformatted by the BFF
  final bool isOpen;
  final String? imageUrl;
  final String? opensAt;

  factory StoreCard.fromJson(Map<String, dynamic> j) => StoreCard(
        id: j['id'] as String,
        name: j['name'] as String,
        rating: (j['rating'] as num?)?.toDouble() ?? 0,
        prepEstimate: j['prepEstimate'] as String? ?? '',
        deliveryFee: j['deliveryFee'] as String? ?? '—',
        isOpen: j['isOpen'] as bool? ?? false,
        imageUrl: j['imageUrl'] as String?,
        opensAt: j['opensAt'] as String?,
      );
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

/// Mirrors the backend state machines. Unknown values map to [unknown]
/// rather than throwing — a new server state must never crash an app that
/// has not been updated yet.
enum OrderState {
  pendingPayment, placed, prescriptionReview, vendorAccepted, preparing,
  readyForPickup, riderAssigned, riderAtVendor, pickedUp, inTransit,
  arrived, delivered, cancelled, failed, vendorRejected,
  processing, vendorDone, deliveredToCustomer, unknown;

  static OrderState fromWire(String s) {
    const map = {
      'pending_payment': OrderState.pendingPayment,
      'placed': OrderState.placed,
      'prescription_review': OrderState.prescriptionReview,
      'vendor_accepted': OrderState.vendorAccepted,
      'preparing': OrderState.preparing,
      'ready_for_pickup': OrderState.readyForPickup,
      'rider_assigned': OrderState.riderAssigned,
      'rider_at_vendor': OrderState.riderAtVendor,
      'picked_up': OrderState.pickedUp,
      'in_transit': OrderState.inTransit,
      'arrived': OrderState.arrived,
      'delivered': OrderState.delivered,
      'delivered_to_customer': OrderState.deliveredToCustomer,
      'cancelled': OrderState.cancelled,
      'failed': OrderState.failed,
      'vendor_rejected': OrderState.vendorRejected,
      'processing': OrderState.processing,
      'vendor_done': OrderState.vendorDone,
    };
    return map[s] ?? OrderState.unknown;
  }

  bool get isTerminal => const {
        OrderState.delivered, OrderState.deliveredToCustomer,
        OrderState.cancelled, OrderState.failed, OrderState.vendorRejected,
      }.contains(this);

  /// Live tracking is only meaningful once a rider is carrying the order.
  bool get isTrackable => const {
        OrderState.pickedUp, OrderState.inTransit, OrderState.arrived,
      }.contains(this);

  /// Customer-facing copy. Never expose raw state names.
  String get customerLabel => switch (this) {
        OrderState.pendingPayment => 'Awaiting payment',
        OrderState.placed => 'Sent to the vendor',
        OrderState.prescriptionReview => 'Pharmacist reviewing',
        OrderState.vendorAccepted => 'Accepted',
        OrderState.preparing => 'Being prepared',
        OrderState.readyForPickup => 'Ready — waiting for a rider',
        OrderState.riderAssigned => 'Rider on the way to collect',
        OrderState.riderAtVendor => 'Rider collecting your order',
        OrderState.pickedUp || OrderState.inTransit => 'On the way to you',
        OrderState.arrived => 'Your rider has arrived',
        OrderState.delivered || OrderState.deliveredToCustomer => 'Delivered',
        OrderState.cancelled => 'Cancelled',
        OrderState.failed => 'Could not be completed',
        OrderState.vendorRejected => 'Vendor could not accept',
        OrderState.processing => 'Being processed',
        OrderState.vendorDone => 'Ready for return',
        OrderState.unknown => 'In progress',
      };
}

class ActiveOrder {
  const ActiveOrder({
    required this.id,
    required this.humanRef,
    required this.state,
    required this.service,
    required this.total,
    this.storeName,
    this.riderName,
    this.etaMinutes,
    this.dropoff,
    this.pickup,
  });

  final String id;
  final String humanRef;
  final OrderState state;
  final String service;
  final Pesewas total;
  final String? storeName;
  final String? riderName;
  final int? etaMinutes;

  /// Where the order is going. Null when the upstream had no pin — the
  /// tracking screen then falls back to the progress trail, which is a
  /// legitimate view rather than a broken one.
  final LatLng? dropoff;

  /// The vendor, shown while the rider is still collecting.
  final LatLng? pickup;

  factory ActiveOrder.fromJson(Map<String, dynamic> j) => ActiveOrder(
        id: j['id'] as String,
        humanRef: j['humanRef'] as String,
        state: OrderState.fromWire(j['state'] as String),
        service: j['service'] as String? ?? 'food',
        total: Pesewas.parse(j['totalPesewas'] as String? ?? '0'),
        storeName: j['storeName'] as String?,
        riderName: j['riderName'] as String?,
        etaMinutes: j['etaMinutes'] as int?,
        dropoff: j['dropoff'] == null
            ? null
            : LatLng.fromJson(j['dropoff'] as Map<String, dynamic>),
        pickup: j['pickup'] == null
            ? null
            : LatLng.fromJson(j['pickup'] as Map<String, dynamic>),
      );

  /// The sticky bar on the home screen.
  String get bannerText => switch (state) {
        OrderState.preparing =>
          '${storeName ?? 'Your order'} is preparing your order',
        OrderState.pickedUp || OrderState.inTransit =>
          etaMinutes != null
              ? 'On the way — about $etaMinutes min'
              : 'Your order is on the way',
        OrderState.arrived => '${riderName ?? 'Your rider'} has arrived',
        _ => state.customerLabel,
      };
}

/* ------------------------------------------------------------------ */
/* Cart                                                                */
/* ------------------------------------------------------------------ */

class AddonOption {
  const AddonOption({
    required this.id, required this.name,
    required this.price, required this.available,
  });
  final String id;
  final String name;
  final Pesewas price;
  final bool available;

  factory AddonOption.fromJson(Map<String, dynamic> j) => AddonOption(
        id: j['id'] as String,
        name: j['name'] as String,
        price: Pesewas.parse(j['pricePesewas'] as String? ?? '0'),
        available: j['available'] as bool? ?? true,
      );
}

class AddonGroup {
  const AddonGroup({
    required this.id, required this.name, required this.required_,
    required this.minSelections, required this.maxSelections,
    required this.options,
  });
  final String id;
  final String name;
  final bool required_;
  final int minSelections;
  final int maxSelections;
  final List<AddonOption> options;

  factory AddonGroup.fromJson(Map<String, dynamic> j) => AddonGroup(
        id: j['id'] as String,
        name: j['name'] as String,
        required_: j['required'] as bool? ?? false,
        minSelections: j['minSelections'] as int? ?? 0,
        maxSelections: j['maxSelections'] as int? ?? 1,
        options: (j['options'] as List<dynamic>? ?? [])
            .map((o) => AddonOption.fromJson(o as Map<String, dynamic>))
            .toList(),
      );

  /// Client-side mirror of the server rule, so the button can be disabled
  /// before a round trip. The server still re-validates.
  String? validate(Set<String> chosen) {
    final n = options.where((o) => chosen.contains(o.id)).length;
    if (required_ && n == 0) return 'Choose a $name';
    if (n < minSelections) return 'Choose at least $minSelections';
    if (n > maxSelections) return 'Choose at most $maxSelections';
    return null;
  }
}

class CartLine {
  CartLine({
    required this.itemId,
    required this.name,
    required this.unitPrice,
    this.quantity = 1,
    Set<String>? addonIds,
    Set<String>? variantIds,
    this.addonTotal = const Pesewas(0),
    this.note,
  })  : addonIds = addonIds ?? {},
        variantIds = variantIds ?? {};

  final String itemId;
  final String name;
  final Pesewas unitPrice;
  int quantity;
  final Set<String> addonIds;
  final Set<String> variantIds;
  final Pesewas addonTotal;
  final String? note;

  Pesewas get lineTotal => Pesewas((unitPrice.value + addonTotal.value) * quantity);

  Map<String, dynamic> toJson() => {
        'itemId': itemId,
        'quantity': quantity,
        if (addonIds.isNotEmpty) 'addonOptionIds': addonIds.toList(),
        if (variantIds.isNotEmpty) 'variantOptionIds': variantIds.toList(),
        if (note != null) 'note': note,
      };
}
