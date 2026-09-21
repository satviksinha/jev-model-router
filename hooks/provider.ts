/**
 * Provider resolution: which backend (TypeSafe direct or Vercel AI Gateway)
 * should handle this request, based on available keys and user overrides.
 *
 * Precedence:
 * 1. JEV_ROUTER_PROVIDER=typesafe|gateway forces one (and errors if its key is missing)
 * 2. TypeSafe direct if TYPESAFE_API_KEY is set
 * 3. Gateway if AI_GATEWAY_API_KEY is set
 * 4. Error if neither is set
 *
 * TYPESAFE_BASE_URL overrides the TypeSafe endpoint base (defaults to https://api.typesafe.ai).
 */

export type ProviderResult =
  | {
      ok: true;
      name: "typesafe" | "gateway";
      endpoint: string;
      model: string;
      apiKey: string;
    }
  | {
      ok: false;
      reason: string;
    };

export type ProviderEnv = {
  TYPESAFE_API_KEY: string | undefined;
  AI_GATEWAY_API_KEY: string | undefined;
  JEV_ROUTER_PROVIDER: string | undefined;
  TYPESAFE_BASE_URL: string | undefined;
};

const TYPESAFE_BASE_DEFAULT = "https://api.typesafe.ai";
const GATEWAY_BASE = "https://ai-gateway.vercel.sh";

export function providerOf(env: ProviderEnv): ProviderResult {
  const forced = (env.JEV_ROUTER_PROVIDER ?? "").toLowerCase().trim();

  // Forced override takes absolute precedence.
  if (forced === "typesafe") {
    if (!env.TYPESAFE_API_KEY) {
      return {
        ok: false,
        reason: "JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set",
      };
    }
    const base = (env.TYPESAFE_BASE_URL ?? TYPESAFE_BASE_DEFAULT).replace(
      /\/$/,
      "",
    );
    return {
      ok: true,
      name: "typesafe",
      endpoint: `${base}/v1/systemone`,
      model: "jev-latest",
      apiKey: env.TYPESAFE_API_KEY,
    };
  }

  if (forced === "gateway") {
    if (!env.AI_GATEWAY_API_KEY) {
      return {
        ok: false,
        reason: "JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set",
      };
    }
    return {
      ok: true,
      name: "gateway",
      endpoint: `${GATEWAY_BASE}/v1/evaluate`,
      model: "typesafe-ai/jev",
      apiKey: env.AI_GATEWAY_API_KEY,
    };
  }

  // No forced override: use default precedence.
  if (env.TYPESAFE_API_KEY) {
    const base = (env.TYPESAFE_BASE_URL ?? TYPESAFE_BASE_DEFAULT).replace(
      /\/$/,
      "",
    );
    return {
      ok: true,
      name: "typesafe",
      endpoint: `${base}/v1/systemone`,
      model: "jev-latest",
      apiKey: env.TYPESAFE_API_KEY,
    };
  }

  if (env.AI_GATEWAY_API_KEY) {
    return {
      ok: true,
      name: "gateway",
      endpoint: `${GATEWAY_BASE}/v1/evaluate`,
      model: "typesafe-ai/jev",
      apiKey: env.AI_GATEWAY_API_KEY,
    };
  }

  return {
    ok: false,
    reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
  };
}
