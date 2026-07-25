/**
 * pricing-svc HTTP surface.
 *
 * A worked example of the shared bootstrap: the service supplies only its
 * controllers, and gets Fastify, RFC-7807 errors, correlation IDs, health
 * probes and graceful shutdown for free.
 *
 * Pricing is a pure calculator — no database, no events — which is why it
 * makes a good first service to wire.
 */

import 'reflect-metadata';
import { Controller, Post, Body, Module, Get } from '@nestjs/common';
import {
  quote, parcelQuote, errandQuote, deliveryFee, codEligible,
  DEFAULT_PRICING, type ServiceType, type SurchargeFlags,
} from './pricing.ts';
import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import { ValidationError } from '../../../libs/platform/src/errors.ts';

/** Money crosses the wire as pesewa STRINGS — JSON has no bigint. */
function pesewaString(v: bigint): string { return v.toString(); }

@Controller('pricing')
export class PricingController {
  @Post('quote')
  quoteOrder(@Body() body: any) {
    requireFields(body, ['service', 'itemTotalPesewas', 'distanceMetres']);
    const q = quote({
      service: body.service as ServiceType,
      itemTotal: BigInt(body.itemTotalPesewas),
      distanceMetres: Number(body.distanceMetres),
      flags: (body.flags ?? {}) as SurchargeFlags,
      ...(body.legs ? { legs: Number(body.legs) } : {}),
    });
    return {
      itemTotalPesewas: pesewaString(q.itemTotal),
      deliveryFeePesewas: pesewaString(q.deliveryFee),
      serviceFeePesewas: pesewaString(q.serviceFee),
      totalPesewas: pesewaString(q.total),
      split: {
        vendorPesewas: pesewaString(q.vendorReceives),
        riderPesewas: pesewaString(q.riderReceives),
        platformPesewas: pesewaString(q.platformReceives),
      },
    };
  }

  @Post('quote/parcel')
  quoteParcel(@Body() body: any) {
    requireFields(body, ['weightKg', 'distanceMetres']);
    const q = parcelQuote(
      Number(body.weightKg), Number(body.distanceMetres), (body.flags ?? {}) as SurchargeFlags,
    );
    return {
      totalPesewas: pesewaString(q.total),
      split: {
        riderPesewas: pesewaString(q.riderReceives),
        platformPesewas: pesewaString(q.platformReceives),
      },
    };
  }

  @Post('quote/errand')
  quoteErrand(@Body() body: any) {
    requireFields(body, ['estimatedItemCostPesewas', 'distanceMetres']);
    const q = errandQuote(
      BigInt(body.estimatedItemCostPesewas), Number(body.distanceMetres),
      (body.flags ?? {}) as SurchargeFlags,
    );
    return {
      totalPesewas: pesewaString(q.total),
      estimatedItemCostPesewas: pesewaString(q.estimatedItemCost),
      autoApproveCeilingPesewas: pesewaString(q.autoApproveCeiling),
      split: {
        riderPesewas: pesewaString(q.riderReceives),
        platformPesewas: pesewaString(q.platformReceives),
      },
    };
  }

  @Post('delivery-fee')
  fee(@Body() body: any) {
    requireFields(body, ['distanceMetres']);
    return {
      feePesewas: pesewaString(
        deliveryFee(Number(body.distanceMetres), (body.flags ?? {}) as SurchargeFlags),
      ),
    };
  }

  @Post('cod/eligible')
  cod(@Body() body: any) {
    requireFields(body, ['orderTotalPesewas', 'service']);
    return codEligible({
      orderTotal: BigInt(body.orderTotalPesewas),
      service: body.service as ServiceType,
      customerCompletedOrders: Number(body.customerCompletedOrders ?? 0),
      riderUnremittedCod: BigInt(body.riderUnremittedCodPesewas ?? '0'),
      hourOfDay: Number(body.hourOfDay ?? new Date().getUTCHours()),
    });
  }

  /** The live rate card — the apps render this rather than hardcoding fees. */
  @Get('config')
  config() {
    return {
      deliveryTiers: DEFAULT_PRICING.deliveryTiers,
      serviceFeeBps: DEFAULT_PRICING.serviceFeeBps,
      surcharges: DEFAULT_PRICING.surcharges,
      parcelWeightBands: DEFAULT_PRICING.parcelWeightBands,
    };
  }
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null) errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

@Module({
  imports: [HealthModule.forRoot(null)],   // pricing has no database
  controllers: [PricingController],
})
export class PricingHttpModule {}
