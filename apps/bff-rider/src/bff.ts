/**
 * Rider BFF. PDF §12, §19.
 *
 * The rider app runs on a phone mounted to a motorbike, on mobile data, in
 * sunlight, often one-handed at a junction. Three consequences shape this:
 *
 *   1. Payloads are small — riders pay for their own data.
 *   2. There is exactly ONE next action at any moment; the app should never
 *      present a choice the rider has to think about while riding.
 *   3. The COD balance is always visible, because it is the rider's debt to
 *      us and the thing that gets them suspended if ignored.
 */

import { toCedis, type Pesewas } from '../../../libs/money/src/money.ts';
import { ForbiddenError, NotFoundError, ConflictError } from '../../../libs/platform/src/errors.ts';
import { codStatus, type CodRiderState } from '../../svc-payment/src/cod/cod-service.ts';

export interface RiderLeg {
  legId: string;
  orderId: string;
  humanRef: string;
  sequence: number;
  legType: string;
  state: string;
  service: string;
  pickup: { lat: number; lng: number; label: string; contactName?: string };
  dropoff: { lat: number; lng: number; label: string; landmark?: string; instructions?: string };
  feePesewas: string;
  isCod: boolean;
  codAmountPesewas?: string;
  assignedRiderId: string | null;
}

export interface LegClient {
  activeForRider(riderId: string): Promise<RiderLeg | null>;
  get(legId: string): Promise<RiderLeg | null>;
}

export interface RiderProfileClient {
  get(riderId: string): Promise<{
    id: string; name: string; isOnline: boolean; vehicle: string; approved: boolean;
  } | null>;
  setOnline(riderId: string, online: boolean): Promise<void>;
}

export interface RiderEarningsClient {
  today(riderId: string): Promise<{ deliveries: number; earnedPesewas: Pesewas; onlineSeconds: number }>;
  wallet(riderId: string): Promise<{ availablePesewas: Pesewas }>;
  codState(riderId: string): Promise<CodRiderState>;
}

/* ------------------------------------------------------------------ */
/* Home screen                                                         */
/* ------------------------------------------------------------------ */

export interface NextAction {
  /** The one button to show. */
  event: string;
  label: string;
  /** Require a proof photo before the event is accepted. */
  requiresProof?: boolean;
  /** Require cash confirmation before completing. */
  requiresCashCollection?: boolean;
}

export interface RiderHome {
  name: string;
  isOnline: boolean;
  canGoOnline: boolean;
  blockedReason?: string;
  today: { deliveries: number; earnedDisplay: string; onlineDisplay: string };
  cod: {
    balanceDisplay: string;
    status: string;
    mustRemit: boolean;
    message?: string;
  };
  currentLeg: {
    legId: string;
    humanRef: string;
    service: string;
    navigateTo: { lat: number; lng: number; label: string };
    landmark?: string;
    instructions?: string;
    earnsDisplay: string;
    collectCashDisplay?: string;
    nextAction: NextAction;
  } | null;
  walletDisplay: string;
}

export class RiderBff {
  constructor(
    private readonly legs: LegClient,
    private readonly profiles: RiderProfileClient,
    private readonly earnings: RiderEarningsClient,
  ) {}

  async home(riderId: string): Promise<RiderHome> {
    const profile = await this.profiles.get(riderId);
    if (!profile) throw new NotFoundError('Rider');

    const [leg, today, wallet, cod] = await Promise.all([
      this.legs.activeForRider(riderId).catch(() => null),
      this.earnings.today(riderId).catch(() => ({ deliveries: 0, earnedPesewas: 0n, onlineSeconds: 0 })),
      this.earnings.wallet(riderId).catch(() => ({ availablePesewas: 0n })),
      this.earnings.codState(riderId).catch(() => ({
        riderId, obligationPesewas: 0n, oldestUnremittedAt: null,
      })),
    ]);

    const codInfo = codStatus(cod);

    return {
      name: profile.name,
      isOnline: profile.isOnline,
      canGoOnline: profile.approved && codInfo.canAcceptAnyOrder,
      ...(!profile.approved
        ? { blockedReason: 'Your account is still under review' }
        : !codInfo.canAcceptAnyOrder
          ? { blockedReason: codInfo.message ?? 'Remit your cash balance to continue' }
          : {}),
      today: {
        deliveries: today.deliveries,
        earnedDisplay: `GHS ${toCedis(today.earnedPesewas)}`,
        onlineDisplay: formatDuration(today.onlineSeconds),
      },
      cod: {
        balanceDisplay: `GHS ${toCedis(cod.obligationPesewas)}`,
        status: codInfo.status,
        mustRemit: codInfo.status === 'blocked' || codInfo.status === 'suspended'
          || codInfo.status === 'warned',
        ...(codInfo.message ? { message: codInfo.message } : {}),
      },
      currentLeg: leg ? this.toCard(leg) : null,
      walletDisplay: `GHS ${toCedis(wallet.availablePesewas)}`,
    };
  }

  private toCard(leg: RiderLeg): NonNullable<RiderHome['currentLeg']> {
    const heading = headingFor(leg.state);
    const target = heading === 'pickup' ? leg.pickup : leg.dropoff;

    return {
      legId: leg.legId,
      humanRef: leg.humanRef,
      service: leg.service,
      navigateTo: { lat: target.lat, lng: target.lng, label: target.label },
      ...(heading === 'dropoff' && leg.dropoff.landmark ? { landmark: leg.dropoff.landmark } : {}),
      ...(heading === 'dropoff' && leg.dropoff.instructions
        ? { instructions: leg.dropoff.instructions } : {}),
      earnsDisplay: `GHS ${toCedis(BigInt(leg.feePesewas))}`,
      ...(leg.isCod && leg.codAmountPesewas
        ? { collectCashDisplay: `GHS ${toCedis(BigInt(leg.codAmountPesewas))}` } : {}),
      nextAction: nextActionFor(leg),
    };
  }

  async goOnline(riderId: string, online: boolean): Promise<{ isOnline: boolean }> {
    const profile = await this.profiles.get(riderId);
    if (!profile) throw new NotFoundError('Rider');
    if (online && !profile.approved) {
      throw new ForbiddenError('Your account is still under review');
    }
    if (online) {
      const cod = await this.earnings.codState(riderId);
      const status = codStatus(cod);
      if (!status.canAcceptAnyOrder) {
        throw new ConflictError(status.message ?? 'Remit your cash balance to go online');
      }
    }
    await this.profiles.setOnline(riderId, online);
    return { isOnline: online };
  }

  /** A rider may only ever act on a leg assigned to them. */
  async assertAssigned(riderId: string, legId: string): Promise<RiderLeg> {
    const leg = await this.legs.get(legId);
    if (!leg) throw new NotFoundError('Assignment');
    if (leg.assignedRiderId !== riderId) {
      throw new ForbiddenError('This delivery is not assigned to you');
    }
    return leg;
  }
}

/** Is the rider heading to the pickup or the dropoff right now? */
export function headingFor(legState: string): 'pickup' | 'dropoff' {
  return ['assigned', 'rider_at_pickup'].includes(legState) ? 'pickup' : 'dropoff';
}

/**
 * Exactly one next action. Cash collection and proof are attached to the
 * final step so the rider cannot complete a delivery without them.
 */
export function nextActionFor(leg: RiderLeg): NextAction {
  switch (leg.state) {
    case 'assigned':
      return { event: 'rider_arrive_pickup', label: 'Arrived at pickup' };
    case 'rider_at_pickup':
      return { event: 'rider_pickup', label: 'Picked up' };
    case 'picked_up':
    case 'in_transit':
      return { event: 'rider_arrive', label: 'Arrived at customer' };
    case 'arrived':
      return {
        event: 'rider_deliver',
        label: leg.isCod ? 'Collect cash & complete' : 'Complete delivery',
        requiresProof: true,
        ...(leg.isCod ? { requiresCashCollection: true } : {}),
      };
    default:
      return { event: 'none', label: 'Waiting' };
  }
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
