/**
 * Tests for provider resolution: which backend (TypeSafe direct or Vercel
 * Gateway) should be used, based on available keys and user overrides.
 */

import assert from 'assert'
import { describe, it } from 'node:test'

import { providerOf } from '../hooks/provider.ts'

describe('providerOf', () => {
  it('prefers TypeSafe direct when TYPESAFE_API_KEY is set', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: 'ts-key',
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'typesafe',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKey: 'ts-key',
    })
  })

  it('falls back to gateway when only AI_GATEWAY_API_KEY is set', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
      model: 'typesafe-ai/jev',
      apiKey: 'gw-key',
    })
  })

  it('returns error when no keys are set', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: 'no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY',
    })
  })

  it('respects JEV_ROUTER_PROVIDER=typesafe override', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: 'ts-key',
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: 'typesafe',
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'typesafe',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKey: 'ts-key',
    })
  })

  it('respects JEV_ROUTER_PROVIDER=gateway override', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: 'ts-key',
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: 'gateway',
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
      model: 'typesafe-ai/jev',
      apiKey: 'gw-key',
    })
  })

  it('errors when forced provider=typesafe but key is missing', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: 'typesafe',
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: 'JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set',
    })
  })

  it('errors when forced provider=gateway but key is missing', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: 'ts-key',
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: 'gateway',
      TYPESAFE_BASE_URL: undefined,
    })

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: 'JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set',
    })
  })

  it('applies TYPESAFE_BASE_URL override', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: 'ts-key',
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: 'https://api.example.com',
    })

    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'typesafe',
      endpoint: 'https://api.example.com/v1/systemone',
      model: 'jev-latest',
      apiKey: 'ts-key',
    })
  })

  it('ignores TYPESAFE_BASE_URL when provider is gateway', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: 'https://api.example.com',
    })

    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
      model: 'typesafe-ai/jev',
      apiKey: 'gw-key',
    })
  })

  it('ignores unrecognised JEV_ROUTER_PROVIDER value and uses defaults', () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: 'ts-key',
      AI_GATEWAY_API_KEY: 'gw-key',
      JEV_ROUTER_PROVIDER: 'unknown',
      TYPESAFE_BASE_URL: undefined,
    })

    // Falls back to default precedence (TypeSafe wins)
    assert.deepStrictEqual(provider, {
      ok: true,
      name: 'typesafe',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKey: 'ts-key',
    })
  })
})
