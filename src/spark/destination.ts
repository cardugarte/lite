export function isSparkUser(user: {
  destination?: string | null;
  sparkIdentityPubkey?: string | null;
}): boolean {
  return user.destination === "spark" || Boolean(user.sparkIdentityPubkey);
}

export function shouldSubscribeNwc(user: {
  destination?: string | null;
  encryptedConnectionSecret?: string | null;
}): boolean {
  if (user.destination === "spark") return false;
  if (user.encryptedConnectionSecret == null || user.encryptedConnectionSecret === "") {
    return false;
  }
  return true;
}

export type CreateUserBody = {
  connectionSecret?: string;
  sparkIdentityPubkey?: string;
  username?: string;
  nostrPubkey?: string;
};

const SPARK_CREATE_REJECTED =
  "sparkIdentityPubkey is not accepted; register Spark addresses through the signed LNURL register";

export type CreateUserRoute =
  | { kind: "nwc"; connectionSecret: string }
  | { kind: "error"; reason: string; status: 400 };

export function routeCreateUser(body: CreateUserBody): CreateUserRoute {
  if ("sparkIdentityPubkey" in body) {
    return { kind: "error", reason: SPARK_CREATE_REJECTED, status: 400 };
  }
  if (!body.connectionSecret) {
    return {
      kind: "error",
      reason: "no connection secret provided",
      status: 400,
    };
  }
  return { kind: "nwc", connectionSecret: body.connectionSecret };
}
