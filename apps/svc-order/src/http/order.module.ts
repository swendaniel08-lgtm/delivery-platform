/**
 * order-svc HTTP surface.
 *
 * The state machine drives everything: a transition is applied, its effects
 * become outbox rows, and both are written in ONE database transaction.
 * No effect is ever published inline (MASTER_PLAN §1.2.2).
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Headers, Inject, Injectable,
  type MiddlewareConsumer, type NestModule,
} from '@nestjs/common';
import { CorrelationMiddleware } from '../../../../libs/platform/src/http/problem-filter.ts';
import type { Pool } from 'pg';
import {
  transition, machineFor, isTerminal, availableEvents,
  type Machine, type OrderState, type OrderEvent,
} from '../state/machine.ts';
import { NotFoundError, ValidationError, ConflictError } from '../../../../libs/platform/src/errors.ts';

export const PG = Symbol('PG_POOL');
export const ORDER_SERVICE = Symbol('ORDER_SERVICE');

/** Vendor commission in basis points, mirroring svc-pricing (PDF §6). */
const COMMISSION_BPS: Record<string, number> = {
  food: 1500, groceries: 1200, shop: 1000,
  market_catalogue: 1500, market_list: 1500, pharmacy: 1000, laundry: 1200,
  parcel: 0, errand: 0,
};

export interface OrderRow {
  id: string;
  human_ref: string;
  customer_id: string;
  store_id: string | null;
  service: string;
  machine: Machine;
  state: OrderState;
  total_pesewas: string;
  item_total_pesewas: string;
  delivery_fee_pesewas: string;
  service_fee_pesewas: string;
  payment_intent: string;
}

export interface ApplyResult {
  orderId: string;
  from: OrderState;
  to: OrderState;
  event: OrderEvent;
  emitted: string[];
}

@Injectable()
export class OrderService {
  constructor(@Inject(PG) private readonly pool: Pool) {}

  async get(id: string): Promise<OrderRow> {
    const r = await this.pool.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
    const row = r.rows[0];
    if (!row) throw new NotFoundError('Order');
    return row;
  }

  async create(input: {
    customerId: string; storeId?: string; service: string;
    itemTotal: bigint; deliveryFee: bigint; serviceFee: bigint;
    paymentIntent: 'prepaid' | 'cod' | 'wallet' | 'mixed';
    hasPrescription?: boolean;
    legs: Array<{
      sequence: number; legType: string;
      pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number };
      feePesewas: bigint;
    }>;
  }): Promise<OrderRow> {
    const machine = machineFor(input.service, { hasPrescription: !!input.hasPrescription });
    const engine = ['parcel', 'errand', 'market_list'].includes(input.service) ? 'request' : 'catalogue';
    const total = input.itemTotal + input.deliveryFee + input.serviceFee;

    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const ref = `#${Math.floor(Math.random() * 900000 + 100000)}`;
      const r = await c.query<OrderRow>(
        `INSERT INTO orders (human_ref, customer_id, store_id, service, engine, machine,
            item_total_pesewas, delivery_fee_pesewas, service_fee_pesewas, total_pesewas,
            payment_intent, requires_prescription)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [ref, input.customerId, input.storeId ?? null, input.service, engine, machine,
         input.itemTotal.toString(), input.deliveryFee.toString(), input.serviceFee.toString(),
         total.toString(), input.paymentIntent, !!input.hasPrescription],
      );
      const order = r.rows[0]!;

      for (const leg of input.legs) {
        await c.query(
          `INSERT INTO delivery_legs (order_id, sequence, leg_type,
              pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fee_pesewas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [order.id, leg.sequence, leg.legType, leg.pickup.lat, leg.pickup.lng,
           leg.dropoff.lat, leg.dropoff.lng, leg.feePesewas.toString()],
        );
      }
      await c.query('COMMIT');
      return order;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }

  /**
   * Apply a state transition. Transition + history + outbox commit together.
   * An illegal transition throws before anything is written.
   */
  async apply(
    orderId: string, event: OrderEvent,
    actor: { type: string; id?: string | undefined }, correlationId?: string,
  ): Promise<ApplyResult> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // lock the row so two concurrent events cannot both transition from the same state
      const r = await c.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId],
      );
      const order = r.rows[0];
      if (!order) throw new NotFoundError('Order');

      const t = transition(order.machine, order.state, event); // throws if illegal

      if (t.to === 'delivered' || t.to === 'delivered_to_customer') {
        // The DB enforces vendor+rider+platform = total on delivered orders,
        // so the settlement split must be written in this same transaction.
        // Computed here from the immutable checkout snapshot.
        const commissionBps = COMMISSION_BPS[order.service] ?? 0;
        const itemTotal = BigInt(order.item_total_pesewas);
        const deliveryFee = BigInt(order.delivery_fee_pesewas);
        const serviceFee = BigInt(order.service_fee_pesewas);
        const commission = (itemTotal * BigInt(commissionBps)) / 10_000n;
        const vendorAmount = itemTotal - commission;
        const riderAmount = deliveryFee;
        const platformAmount = commission + serviceFee;

        await c.query(
          `UPDATE orders SET state = $2, delivered_at = now(),
              vendor_amount_pesewas = $3, rider_amount_pesewas = $4, platform_amount_pesewas = $5
            WHERE id = $1`,
          [orderId, t.to, vendorAmount.toString(), riderAmount.toString(), platformAmount.toString()],
        );
      } else {
        await c.query('UPDATE orders SET state = $2 WHERE id = $1', [orderId, t.to]);
      }
      if (t.to === 'placed') {
        await c.query('UPDATE orders SET placed_at = now() WHERE id = $1', [orderId]);
      }

      await c.query(
        `INSERT INTO order_state_history (order_id, from_state, to_state, event, actor_type, actor_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, order.state, t.to, event, actor.type, actor.id ?? null, correlationId ?? null],
      );

      // effects → outbox, in the SAME transaction
      for (const evt of t.effects.events) {
        await c.query(
          `INSERT INTO outbox (event_type, aggregate_id, payload, correlation_id)
           VALUES ($1,$2,$3,$4)`,
          [evt, orderId, JSON.stringify({
            orderId, humanRef: order.human_ref, from: order.state, to: t.to,
            service: order.service, totalPesewas: order.total_pesewas,
          }), correlationId ?? null],
        );
      }

      if (t.effects.startTimer) {
        await c.query(
          `INSERT INTO order_timers (order_id, name, fire_at, event, expect_state)
           VALUES ($1,$2, now() + ($3 || ' seconds')::interval, $4, $5)
           ON CONFLICT DO NOTHING`,
          [orderId, t.effects.startTimer.name, String(t.effects.startTimer.seconds),
           'auto_timeout', t.to],
        );
      }
      if (t.effects.cancelTimers) {
        await c.query(
          `UPDATE order_timers SET cancelled_at = now()
            WHERE order_id = $1 AND fired_at IS NULL AND cancelled_at IS NULL`, [orderId],
        );
      }

      await c.query('COMMIT');
      return { orderId, from: order.state, to: t.to, event, emitted: t.effects.events };
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }

  async history(orderId: string) {
    const r = await this.pool.query(
      `SELECT from_state, to_state, event, actor_type, created_at
         FROM order_state_history WHERE order_id = $1 ORDER BY id`, [orderId]);
    return r.rows;
  }

  async legs(orderId: string) {
    const r = await this.pool.query(
      'SELECT * FROM delivery_legs WHERE order_id = $1 ORDER BY sequence', [orderId]);
    return r.rows;
  }
}

@Controller('orders')
export class OrderController {
  // Explicit @Inject: esbuild/tsx does not emit design:paramtypes metadata,
  // so Nest cannot infer constructor types by class alone.
  constructor(@Inject(ORDER_SERVICE) private readonly orders: OrderService) {}

  @Post()
  async create(@Body() body: any) {
    if (!body?.customerId) throw new ValidationError({ customerId: ['is required'] });
    if (!Array.isArray(body.legs) || body.legs.length === 0) {
      throw new ValidationError({ legs: ['at least one delivery leg is required'] });
    }
    const order = await this.orders.create({
      customerId: body.customerId,
      storeId: body.storeId,
      service: body.service,
      itemTotal: BigInt(body.itemTotalPesewas ?? 0),
      deliveryFee: BigInt(body.deliveryFeePesewas ?? 0),
      serviceFee: BigInt(body.serviceFeePesewas ?? 0),
      paymentIntent: body.paymentIntent ?? 'prepaid',
      hasPrescription: body.hasPrescription,
      legs: body.legs.map((l: any) => ({
        sequence: l.sequence, legType: l.legType,
        pickup: l.pickup, dropoff: l.dropoff,
        feePesewas: BigInt(l.feePesewas ?? 0),
      })),
    });
    return serialise(order);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const o = await this.orders.get(id);
    return {
      ...serialise(o),
      availableEvents: availableEvents(o.machine, o.state),
      terminal: isTerminal(o.state),
    };
  }

  @Get(':id/history')
  history(@Param('id') id: string) { return this.orders.history(id); }

  @Get(':id/legs')
  legs(@Param('id') id: string) { return this.orders.legs(id); }

  @Post(':id/events')
  async apply(
    @Param('id') id: string,
    @Body() body: { event: OrderEvent; actorType?: string; actorId?: string },
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!body?.event) throw new ValidationError({ event: ['is required'] });
    return this.orders.apply(
      id, body.event,
      { type: body.actorType ?? 'system', id: body.actorId },
      correlationId,
    );
  }
}

@Controller('health')
export class HealthController {
  constructor(@Inject(PG) private readonly pool: Pool) {}
  @Get() live() { return { status: 'ok' }; }
  @Get('ready')
  async ready() {
    await this.pool.query('SELECT 1');
    return { status: 'ready' };
  }
}

/** bigint columns come back as strings from pg; keep them strings on the wire. */
function serialise(o: OrderRow) {
  return {
    id: o.id, humanRef: o.human_ref, customerId: o.customer_id, storeId: o.store_id,
    service: o.service, machine: o.machine, state: o.state,
    itemTotalPesewas: o.item_total_pesewas,
    deliveryFeePesewas: o.delivery_fee_pesewas,
    serviceFeePesewas: o.service_fee_pesewas,
    totalPesewas: o.total_pesewas,
    paymentIntent: o.payment_intent,
  };
}

/**
 * Built as a dynamic module so the caller supplies the pg Pool.
 * A plain @Module cannot see providers declared in a parent module —
 * Nest DI is per-module, not global by default.
 */
@Module({})
export class OrderModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }

  static forRoot(pool: Pool) {
    return {
      module: OrderModule,
      controllers: [OrderController, HealthController],
      providers: [
        { provide: PG, useValue: pool },
        { provide: ORDER_SERVICE, useFactory: (p: Pool) => new OrderService(p), inject: [PG] },
      ],
      exports: [ORDER_SERVICE, PG],
    };
  }
}
