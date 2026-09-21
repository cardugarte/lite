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

export type CreateUserRoute =
  | { kind: "nwc"; connectionSecret: string }
  | { kind: "spark"; sparkIdentityPubkey: string }
  | { kind: "error"; reason: string; status: 400 };

export function routeCreateUser(body: CreateUserBody): CreateUserRoute {
  const hasSecret = Boolean(body.connectionSecret);
  const hasSpark = Boolean(body.sparkIdentityPubkey);

  if (hasSecret && hasSpark) {
    return {
      kind: "error",
      reason: "Provide either connectionSecret or sparkIdentityPubkey, not both",
      status: 400,
    };
  }
  if (hasSpark) {
    return { kind: "spark", sparkIdentityPubkey: body.sparkIdentityPubkey as string };
  }
  if (hasSecret) {
    return { kind: "nwc", connectionSecret: body.connectionSecret as string };
  }
  return {
    kind: "error",
    reason: "no connection secret provided",
    status: 400,
  };
}
