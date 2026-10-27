const error = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
    },
  },
};
const json = (schema: object) => ({ "application/json": { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { description: errorText[c], content: json(error) }]));
const errorText: Record<number, string> = {
  400: "Validation error or missing Idempotency-Key",
  401: "Missing or invalid API key",
  404: "Not found",
  409: "A request with this Idempotency-Key is still in progress",
  422: "Business rule failed (e.g. insufficient_funds) or Idempotency-Key reused with a different body",
};

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description:
    "Unique key per logical operation (e.g. a UUID). Retrying with the same key and body returns the original response with `Idempotent-Replayed: true` and moves no money.",
  schema: { type: "string", maxLength: 255 },
};

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "PayLedger API",
    version: "1.0.0",
    description:
      "A double-entry payments ledger. Amounts are integers in **kobo** (₦1 = 100 kobo).\n\n" +
      "Get a sandbox key with `POST /v1/sandbox`, then send `Authorization: Bearer <api_key>`.\n\n" +
      "Every money movement is a journal entry whose postings sum to zero. Webhooks are signed with " +
      "`PayLedger-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, \"t.body\")>`.",
  },
  servers: [{ url: "/" }],
  tags: [{ name: "Sandbox" }, { name: "Accounts" }, { name: "Money movement" }, { name: "Ledger" }, { name: "Webhooks" }],
  security: [{ bearer: [] }],
  paths: {
    "/v1/sandbox": {
      post: {
        tags: ["Sandbox"],
        summary: "Create a sandbox workspace",
        description: "Creates an isolated workspace with two funded customer accounts and a webhook endpoint. Rate limited.",
        security: [],
        responses: {
          "201": {
            description: "API key (shown once) and webhook signing secret",
            content: json({
              type: "object",
              properties: { workspace_id: { type: "string" }, api_key: { type: "string" }, webhook_secret: { type: "string" } },
            }),
          },
        },
      },
    },
    "/v1/accounts": {
      get: { tags: ["Accounts"], summary: "List accounts", responses: { "200": { description: "Accounts", content: json({ type: "object", properties: { data: { type: "array", items: ref("Account") } } }) }, ...errors(401) } },
      post: {
        tags: ["Accounts"],
        summary: "Create a customer account",
        requestBody: { required: true, content: json({ type: "object", required: ["name"], properties: { name: { type: "string", example: "Chioma Eze" } } }) },
        responses: { "201": { description: "Created", content: json(ref("Account")) }, ...errors(400, 401, 422) },
      },
    },
    "/v1/accounts/{id}": {
      get: {
        tags: ["Accounts"],
        summary: "Get an account",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Account", content: json(ref("Account")) }, ...errors(401, 404) },
      },
    },
    "/v1/accounts/{id}/postings": {
      get: {
        tags: ["Accounts"],
        summary: "Account statement",
        description: "The account's postings, newest first, each with the running balance after it.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
        ],
        responses: { "200": { description: "Statement lines" }, ...errors(401, 404) },
      },
    },
    "/v1/deposits": {
      post: {
        tags: ["Money movement"],
        summary: "Deposit into a customer account",
        description: "Posts settlement −amount, customer +amount.",
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["account_id", "amount"],
            properties: { account_id: { type: "string" }, amount: { type: "integer", example: 500000 }, description: { type: "string" } },
          }),
        },
        responses: { "201": { description: "Journal entry", content: json(ref("Entry")) }, ...errors(400, 401, 404, 409, 422) },
      },
    },
    "/v1/transfers": {
      post: {
        tags: ["Money movement"],
        summary: "Transfer between customer accounts",
        description:
          "Fee is 0.5% rounded up to the kobo, capped at ₦100. Posts sender −(amount+fee), receiver +amount, fee revenue +fee in one entry. Accounts are locked in ID order, so concurrent transfers can't overdraw or deadlock.",
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["from_account_id", "to_account_id", "amount"],
            properties: {
              from_account_id: { type: "string" },
              to_account_id: { type: "string" },
              amount: { type: "integer", example: 250000 },
              description: { type: "string", example: "Rent share" },
            },
          }),
        },
        responses: { "201": { description: "Journal entry", content: json(ref("Entry")) }, ...errors(400, 401, 404, 409, 422) },
      },
    },
    "/v1/entries": {
      get: {
        tags: ["Ledger"],
        summary: "Journal entries with postings, newest first",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }],
        responses: { "200": { description: "Entries" }, ...errors(401) },
      },
    },
    "/v1/reconciliation": {
      get: {
        tags: ["Ledger"],
        summary: "Reconcile balances against the ledger",
        description: "Checks each stored balance equals the sum of its postings and that all postings sum to zero.",
        responses: { "200": { description: "Reconciliation report" }, ...errors(401) },
      },
    },
    "/v1/webhooks/endpoints": {
      get: { tags: ["Webhooks"], summary: "List webhook endpoints", responses: { "200": { description: "Endpoints" }, ...errors(401) } },
    },
    "/v1/webhooks/endpoints/{id}": {
      patch: {
        tags: ["Webhooks"],
        summary: "Enable/disable an endpoint or change the demo receiver's failure rate",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: json({
            type: "object",
            properties: { enabled: { type: "boolean" }, simulated_failure_rate: { type: "number", minimum: 0, maximum: 1, example: 0.5 } },
          }),
        },
        responses: { "200": { description: "Updated endpoint" }, ...errors(400, 401, 404) },
      },
    },
    "/v1/webhooks/deliveries": {
      get: {
        tags: ["Webhooks"],
        summary: "Recent webhook deliveries and their retry state",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }],
        responses: { "200": { description: "Deliveries" }, ...errors(401) },
      },
    },
    "/v1/webhooks/deliveries/{id}/retry": {
      post: {
        tags: ["Webhooks"],
        summary: "Replay a failed delivery now",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "202": { description: "Queued" }, ...errors(401, 422) },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    schemas: {
      Account: {
        type: "object",
        properties: {
          id: { type: "string", example: "acc_3kF9xQ2mT7bLp0Za" },
          name: { type: "string" },
          type: { type: "string", enum: ["customer", "settlement", "fees"] },
          currency: { type: "string", example: "NGN" },
          balance: { type: "integer", description: "Kobo" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Entry: {
        type: "object",
        properties: {
          id: { type: "string", example: "je_Zq1..." },
          type: { type: "string", enum: ["deposit", "transfer"] },
          amount: { type: "integer" },
          fee: { type: "integer" },
          description: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          postings: {
            type: "array",
            items: {
              type: "object",
              properties: { account_id: { type: "string" }, amount: { type: "integer" }, balance_after: { type: "integer" } },
            },
          },
        },
      },
    },
  },
};
