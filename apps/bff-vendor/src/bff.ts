/**
 * Vendor BFF. PDF §11, §19.
 *
 * The vendor app is used one-handed, in a hot kitchen, while cooking. Every
 * decision here optimises for that: the dashboard is one call, new orders are
 * impossible to miss, and the accept/reject deadline is always visible as a
 * countdown rather than an abstract rule.
 *
 * Tenant isolation is enforced on every method — a vendor may only ever see
 * their own store's data, and `vendorId` comes from the verified JWT the
 * gateway forwarded, never from the request body.
 */

import { add, formatCedis, type Pesewas } from '../../../libs/money/src/money.ts';
import { ForbiddenError, NotFoundError } from '../../../libs/platform/src/errors.ts';
import { VENDOR_ACCEPT_SECONDS } from '../../svc-order/src/state/machine.ts';

export interface VendorOrderLine {
  name: string;
  quantity: number;
  addonNames: string[];
  variantNames: string[];
  note?: string;
}

export interface VendorOrder {
  id: string;
  humanRef: string;
  storeId: string;
  state: string;
  service: string;
  lines: VendorOrderLine[];
  itemTotalPesewas: string;
  /** Vendor's share after commission — what they actually earn. */
  vendorAmountPesewas: string;
  placedAt: string;
  customerNote?: string;
  riderName?: string;
  isCod: boolean;
  requiresPrescription: boolean;
}

export interface OrderClient {
  forStore(storeId: string, states: string[]): Promise<VendorOrder[]>;
  get(orderId: string): Promise<VendorOrder | null>;
}

export interface StoreClient {
  get(storeId: string): Promise<{
    id: string; ownerId: string; name: string; isOpen: boolean;
    isOpenOverride: boolean | null; rating: number;
  } | null>;
  setOpenOverride(storeId: string, open: boolean | null): Promise<void>;
}

export interface EarningsClient {
  todayForStore(storeId: string): Promise<{
    orderCount: number; grossPesewas: Pesewas; netPesewas: Pesewas;
  }>;
  walletBalance(vendorId: string): Promise<{
    availablePesewas: Pesewas; pendingPesewas: Pesewas;
  }>;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface ActionableOrder {
  id: string;
  humanRef: string;
  lines: VendorOrderLine[];
  totalDisplay: string;
  earnsDisplay: string;
  /** Countdown for new orders — 0 means the auto-reject is imminent. */
  secondsToRespond?: number;
  /** Urgency for the UI: red when under a minute. */
  urgent?: boolean;
  isCod: boolean;
  requiresPrescription: boolean;
  primaryAction: 'accept' | 'mark_preparing' | 'mark_ready' | 'awaiting_rider' | 'none';
}

export interface VendorDashboard {
  storeName: string;
  isOpen: boolean;
  today: { orders: number; revenueDisplay: string; rating: number };
  newOrders: ActionableOrder[];
  inProgress: ActionableOrder[];
  completedToday: number;
  walletDisplay: string;
}

const NEW = ['placed', 'prescription_review'];
const IN_PROGRESS = [
  'vendor_accepted', 'preparing', 'ready_for_pickup', 'rider_assigned',
  'rider_at_vendor', 'vendor_received', 'processing', 'vendor_done',
];
const DONE = ['delivered', 'delivered_to_customer'];

export class VendorBff {
  constructor(
    private readonly orders: OrderClient,
    private readonly stores: StoreClient,
    private readonly earnings: EarningsClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every method funnels through this. Ownership is never assumed. */
  private async assertOwnership(vendorUserId: string, storeId: string) {
    const store = await this.stores.get(storeId);
    if (!store) throw new NotFoundError('Store');
    if (store.ownerId !== vendorUserId) {
      throw new ForbiddenError('This store does not belong to you');
    }
    return store;
  }

  async dashboard(vendorUserId: string, storeId: string): Promise<VendorDashboard> {
    const store = await this.assertOwnership(vendorUserId, storeId);

    const [active, today, wallet] = await Promise.all([
      this.orders.forStore(storeId, [...NEW, ...IN_PROGRESS, ...DONE]),
      this.earnings.todayForStore(storeId).catch(() => ({
        orderCount: 0, grossPesewas: 0n, netPesewas: 0n,
      })),
      this.earnings.walletBalance(vendorUserId).catch(() => ({
        availablePesewas: 0n, pendingPesewas: 0n,
      })),
    ]);

    const newOrders = active
      .filter((o) => NEW.includes(o.state))
      .map((o) => this.toActionable(o))
      // most urgent first — the one about to auto-reject sits at the top
      .sort((a, b) => (a.secondsToRespond ?? 1e9) - (b.secondsToRespond ?? 1e9));

    return {
      storeName: store.name,
      isOpen: store.isOpen,
      today: {
        orders: today.orderCount,
        revenueDisplay: formatCedis(today.netPesewas),
        rating: store.rating,
      },
      newOrders,
      inProgress: active.filter((o) => IN_PROGRESS.includes(o.state)).map((o) => this.toActionable(o)),
      completedToday: active.filter((o) => DONE.includes(o.state)).length,
      walletDisplay: formatCedis(wallet.availablePesewas),
    };
  }

  private toActionable(o: VendorOrder): ActionableOrder {
    const base: ActionableOrder = {
      id: o.id,
      humanRef: o.humanRef,
      lines: o.lines,
      totalDisplay: formatCedis(BigInt(o.itemTotalPesewas)),
      earnsDisplay: formatCedis(BigInt(o.vendorAmountPesewas)),
      isCod: o.isCod,
      requiresPrescription: o.requiresPrescription,
      primaryAction: primaryActionFor(o.state),
    };

    if (o.state === 'placed') {
      const elapsed = (this.now().getTime() - new Date(o.placedAt).getTime()) / 1000;
      const remaining = Math.max(0, Math.round(VENDOR_ACCEPT_SECONDS - elapsed));
      base.secondsToRespond = remaining;
      base.urgent = remaining <= 60;
    }
    return base;
  }

  /** Vendor taps the open/closed switch. `null` returns to the schedule. */
  async setOpen(vendorUserId: string, storeId: string, open: boolean | null): Promise<void> {
    await this.assertOwnership(vendorUserId, storeId);
    await this.stores.setOpenOverride(storeId, open);
  }

  async orderDetail(vendorUserId: string, storeId: string, orderId: string): Promise<VendorOrder> {
    await this.assertOwnership(vendorUserId, storeId);
    const order = await this.orders.get(orderId);
    if (!order) throw new NotFoundError('Order');
    // Defence in depth: even a valid order id from another store is refused.
    if (order.storeId !== storeId) throw new ForbiddenError('This order is not for your store');
    return order;
  }
}

/** The single button the vendor should press next, given the state. */
export function primaryActionFor(state: string): ActionableOrder['primaryAction'] {
  switch (state) {
    case 'placed': return 'accept';
    case 'vendor_accepted': return 'mark_preparing';
    case 'preparing': return 'mark_ready';
    case 'ready_for_pickup':
    case 'rider_assigned':
    case 'rider_at_vendor': return 'awaiting_rider';
    default: return 'none';
  }
}
